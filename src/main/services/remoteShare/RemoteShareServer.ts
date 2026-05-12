import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
  ClientMessage,
  DirEntry,
  DirRoot,
  FileChangesResult,
  FileDiff,
  GitLogEntry,
  GitStatus,
  ProjectInfo,
  RemoteShareConfig,
  RemoteShareStatus,
  ServerMessage,
} from '@shared/types';
import { type WebSocket, WebSocketServer } from 'ws';
import { GitService } from '../git/GitService';
import type { PtyManager } from '../terminal/PtyManager';

// Resolve web directory: tries multiple locations for dev and prod builds
function resolveWebDir(): string {
  // 1. Relative to bundled output (out/main/web/ or out/main/services/remoteShare/web/)
  const candidates = [
    path.join(__dirname, 'web'),
    path.join(__dirname, 'services', 'remoteShare', 'web'),
  ];

  // 2. In dev mode, __dirname is out/main/ but source is in src/
  // electron-vite bundles to out/main/index.js, so check relative to project root
  const projectRoot = path.resolve(__dirname, '..', '..');
  candidates.push(path.join(projectRoot, 'src', 'main', 'services', 'remoteShare', 'web'));
  candidates.push(path.join(projectRoot, 'out', 'main', 'web'));

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }

  // Fallback: return first candidate (will show 404 but won't crash)
  return candidates[0];
}

const WEB_DIR = resolveWebDir();

// Binary file extensions to skip in file read
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
  '.flac',
  '.wav',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.obj',
  '.o',
  '.a',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.sqlite',
  '.db',
  '.wasm',
]);

const MAX_FILE_READ_SIZE = 1024 * 1024; // 1MB

export class RemoteShareServer extends EventEmitter {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private status: RemoteShareStatus = { running: false };
  private ptyManager: PtyManager;
  private config: RemoteShareConfig | null = null;

  // Track subscriptions: ws -> Map<sessionId, unsubscribeFn>
  private subscriptions = new Map<WebSocket, Map<string, () => void>>();

  // Track remote-created sessions: sessionId -> ws
  private remoteSessionOwners = new Map<string, WebSocket>();

  // Registered projects
  private projects = new Map<string, ProjectInfo>();

  // Cached GitService instances per workdir
  private gitServices = new Map<string, GitService>();

  constructor(ptyManager: PtyManager) {
    super();
    this.ptyManager = ptyManager;
  }

  async start(config: RemoteShareConfig): Promise<RemoteShareStatus> {
    if (this.httpServer) {
      return this.status;
    }

    this.config = config;

    try {
      this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));

      this.wss = new WebSocketServer({
        server: this.httpServer,
        verifyClient: (info, cb) => {
          // Token validation on upgrade
          const url = new URL(
            info.req.url || '/',
            `http://${info.req.headers.host || 'localhost'}`
          );
          const token = url.searchParams.get('token');
          if (!token || token !== config.authToken) {
            cb(false, 401, 'Unauthorized');
            return;
          }
          cb(true);
        },
      });

      this.wss.on('connection', (ws) => this.handleConnection(ws));

      await new Promise<void>((resolve, reject) => {
        if (!this.httpServer) return reject(new Error('Server not created'));
        this.httpServer.listen(config.port, '0.0.0.0', () => resolve());
        this.httpServer.on('error', reject);
      });

      this.status = { running: true, port: config.port };
      this.emit('statusChanged', this.status);
      console.log(`[remote-share] Server listening on port ${config.port}`);
      return this.status;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Handle EADDRINUSE
      if (errorMsg.includes('EADDRINUSE')) {
        this.status = { running: false, error: `端口 ${config.port} 已被占用` };
      } else {
        this.status = { running: false, error: errorMsg };
      }
      this.emit('statusChanged', this.status);
      this.cleanupServer();
      return this.status;
    }
  }

  async stop(): Promise<RemoteShareStatus> {
    this.cleanupServer();
    this.status = { running: false };
    this.emit('statusChanged', this.status);
    return this.status;
  }

  getStatus(): RemoteShareStatus {
    return { ...this.status };
  }

  cleanup(): void {
    this.cleanupServer();
  }

  private cleanupServer(): void {
    // Close all WebSocket connections
    if (this.wss) {
      for (const ws of this.wss.clients) {
        this.cleanupSubscriptions(ws);
        ws.terminate();
      }
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    this.gitServices.clear();
    this.remoteSessionOwners.clear();
  }

  // --- HTTP Static File Serving ---

  private serveFile(filePath: string, res: http.ServerResponse): void {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.wasm': 'application/wasm',
    };

    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Route: static files
    if (url.pathname === '/' || url.pathname === '/index.html') {
      this.serveFile(path.join(WEB_DIR, 'index.html'), res);
      return;
    }

    // Serve web assets
    const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(WEB_DIR, safePath);
    if (filePath.startsWith(WEB_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      this.serveFile(filePath, res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  // --- WebSocket Connection Handling ---

  private handleConnection(ws: WebSocket): void {
    console.log('[remote-share] Client connected');
    this.subscriptions.set(ws, new Map());

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        this.handleMessage(ws, msg);
      } catch (error) {
        this.send(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      console.log('[remote-share] Client disconnected');
      this.cleanupSubscriptions(ws);
      this.subscriptions.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('[remote-share] WebSocket error:', error.message);
      this.cleanupSubscriptions(ws);
      this.subscriptions.delete(ws);
    });
  }

  private handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
      case 'session:list':
        this.handleSessionList(ws);
        break;
      case 'session:create':
        this.handleSessionCreate(ws, msg);
        break;
      case 'session:connect':
        this.handleSessionConnect(ws, msg.sessionId);
        break;
      case 'session:disconnect':
        this.handleSessionDisconnect(ws, msg.sessionId);
        break;
      case 'session:destroy':
        this.handleSessionDestroy(ws, msg.sessionId);
        break;
      case 'session:write':
        this.ptyManager.write(msg.sessionId, msg.data);
        break;
      case 'session:resize':
        this.ptyManager.resize(msg.sessionId, msg.cols, msg.rows);
        break;
      case 'file:list':
        this.handleFileList(ws, msg.path);
        break;
      case 'file:read':
        this.handleFileRead(ws, msg.path);
        break;
      // Project management
      case 'project:list':
        this.handleProjectList(ws);
        break;
      case 'project:add':
        this.handleProjectAdd(ws, msg.path);
        break;
      case 'project:remove':
        this.handleProjectRemove(ws, msg.path);
        break;
      // Git operations
      case 'git:status':
        this.handleGitStatus(ws, msg.workdir);
        break;
      case 'git:log':
        this.handleGitLog(ws, msg);
        break;
      case 'git:stage':
        this.handleGitStage(ws, msg);
        break;
      case 'git:unstage':
        this.handleGitUnstage(ws, msg);
        break;
      case 'git:commit':
        this.handleGitCommit(ws, msg);
        break;
      case 'git:diff':
        this.handleGitDiff(ws, msg);
        break;
      case 'git:fileChanges':
        this.handleGitFileChanges(ws, msg.workdir);
        break;
      // Command execution
      case 'command:run':
        this.handleCommandRun(ws, msg);
        break;
      // Directory browsing
      case 'dir:roots':
        this.handleDirRoots(ws);
        break;
      case 'dir:browse':
        this.handleDirBrowse(ws, msg.path);
        break;
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // --- Session Management ---

  private handleSessionList(ws: WebSocket): void {
    const sessions = this.ptyManager.listSessions().map((s) => ({
      id: s.id,
      cwd: s.cwd,
      isLocal: !this.remoteSessionOwners.has(s.id),
    }));
    this.send(ws, { type: 'session:list', sessions });
  }

  private handleSessionCreate(
    ws: WebSocket,
    msg: { cwd?: string; cols?: number; rows?: number }
  ): void {
    const id = this.ptyManager.create(
      {
        cwd: msg.cwd,
        cols: msg.cols || 80,
        rows: msg.rows || 24,
      },
      () => {}, // Data handled via subscribeToSession
      (exitCode) => {
        this.send(ws, { type: 'session:exited', sessionId: id, exitCode });
        this.removeSubscription(ws, id);
        this.remoteSessionOwners.delete(id);
      },
      null // No ownerId for remote sessions
    );

    // Track as remote-created
    this.remoteSessionOwners.set(id, ws);

    const info = this.ptyManager.listSessions().find((s) => s.id === id);
    this.send(ws, {
      type: 'session:created',
      session: info ? { ...info, isLocal: false } : { id, cwd: msg.cwd || '', isLocal: false },
    });

    // Auto-connect to the new session
    this.handleSessionConnect(ws, id);
  }

  private handleSessionConnect(ws: WebSocket, sessionId: string): void {
    const unsub = this.ptyManager.subscribeToSession(sessionId, (data) => {
      this.send(ws, { type: 'session:data', sessionId, data });
    });

    if (!unsub) {
      this.send(ws, { type: 'session:error', sessionId, error: '会话不存在' });
      return;
    }

    const subs = this.subscriptions.get(ws);
    if (subs) {
      subs.set(sessionId, unsub);
    }
    this.send(ws, { type: 'session:connected', sessionId });
  }

  private handleSessionDisconnect(ws: WebSocket, sessionId: string): void {
    this.removeSubscription(ws, sessionId);
  }

  private handleSessionDestroy(ws: WebSocket, sessionId: string): void {
    // Only allow destroying remote-created sessions
    if (!this.remoteSessionOwners.has(sessionId)) {
      this.send(ws, { type: 'session:error', sessionId, error: '无法销毁本地会话' });
      return;
    }
    this.removeSubscription(ws, sessionId);
    this.ptyManager.destroy(sessionId);
    this.remoteSessionOwners.delete(sessionId);
  }

  private removeSubscription(ws: WebSocket, sessionId: string): void {
    const subs = this.subscriptions.get(ws);
    if (subs) {
      const unsub = subs.get(sessionId);
      if (unsub) {
        unsub();
        subs.delete(sessionId);
      }
    }
  }

  private cleanupSubscriptions(ws: WebSocket): void {
    const subs = this.subscriptions.get(ws);
    if (subs) {
      for (const unsub of subs.values()) {
        unsub();
      }
      subs.clear();
    }
  }

  // --- Project Management ---

  private handleProjectList(ws: WebSocket): void {
    const projects = Array.from(this.projects.values());
    this.send(ws, { type: 'project:list', projects });
  }

  private handleProjectAdd(ws: WebSocket, projectPath: string): void {
    try {
      const resolved = path.resolve(projectPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        this.send(ws, { type: 'project:error', error: '路径不存在或不是目录' });
        return;
      }

      const gitDir = path.join(resolved, '.git');
      const isValid = fs.existsSync(gitDir);
      if (!isValid) {
        this.send(ws, { type: 'project:error', error: '不是有效的 Git 仓库' });
        return;
      }

      const name = path.basename(resolved);
      const info: ProjectInfo = { name, path: resolved, isValid: true };
      this.projects.set(resolved, info);

      // Pre-create GitService
      this.getOrCreateGitService(resolved);

      this.send(ws, { type: 'project:added', project: info });
    } catch (error) {
      this.send(ws, {
        type: 'project:error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleProjectRemove(ws: WebSocket, projectPath: string): void {
    const resolved = path.resolve(projectPath);
    this.projects.delete(resolved);
    this.gitServices.delete(resolved);
    this.send(ws, { type: 'project:removed', path: resolved });
  }

  // --- Git Operations ---

  private getOrCreateGitService(workdir: string): GitService {
    let service = this.gitServices.get(workdir);
    if (!service) {
      service = new GitService(workdir);
      this.gitServices.set(workdir, service);
    }
    return service;
  }

  private validateProjectWorkdir(workdir: string): boolean {
    return this.projects.has(path.resolve(workdir));
  }

  private async handleGitStatus(ws: WebSocket, workdir: string): Promise<void> {
    if (!this.validateProjectWorkdir(workdir)) {
      this.send(ws, { type: 'git:error', workdir, error: '项目未注册' });
      return;
    }
    try {
      const git = this.getOrCreateGitService(workdir);
      const status: GitStatus = await git.getStatus();
      this.send(ws, { type: 'git:status', workdir, status });
    } catch (error) {
      this.send(ws, {
        type: 'git:error',
        workdir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGitLog(
    ws: WebSocket,
    msg: { workdir: string; maxCount?: number; skip?: number }
  ): Promise<void> {
    if (!this.validateProjectWorkdir(msg.workdir)) {
      this.send(ws, { type: 'git:error', workdir: msg.workdir, error: '项目未注册' });
      return;
    }
    try {
      const git = this.getOrCreateGitService(msg.workdir);
      const entries: GitLogEntry[] = await git.getLog(msg.maxCount || 20, msg.skip);
      this.send(ws, { type: 'git:log', workdir: msg.workdir, entries });
    } catch (error) {
      this.send(ws, {
        type: 'git:error',
        workdir: msg.workdir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGitStage(
    ws: WebSocket,
    msg: { workdir: string; paths: string[] }
  ): Promise<void> {
    if (!this.validateProjectWorkdir(msg.workdir)) {
      this.send(ws, { type: 'git:error', workdir: msg.workdir, error: '项目未注册' });
      return;
    }
    try {
      const git = this.getOrCreateGitService(msg.workdir);
      await git.stage(msg.paths);
      this.send(ws, { type: 'git:staged', workdir: msg.workdir });
    } catch (error) {
      this.send(ws, {
        type: 'git:error',
        workdir: msg.workdir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGitUnstage(
    ws: WebSocket,
    msg: { workdir: string; paths: string[] }
  ): Promise<void> {
    if (!this.validateProjectWorkdir(msg.workdir)) {
      this.send(ws, { type: 'git:error', workdir: msg.workdir, error: '项目未注册' });
      return;
    }
    try {
      const git = this.getOrCreateGitService(msg.workdir);
      await git.unstage(msg.paths);
      this.send(ws, { type: 'git:unstaged', workdir: msg.workdir });
    } catch (error) {
      this.send(ws, {
        type: 'git:error',
        workdir: msg.workdir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGitCommit(
    ws: WebSocket,
    msg: { workdir: string; message: string; files?: string[] }
  ): Promise<void> {
    if (!this.validateProjectWorkdir(msg.workdir)) {
      this.send(ws, { type: 'git:error', workdir: msg.workdir, error: '项目未注册' });
      return;
    }
    try {
      const git = this.getOrCreateGitService(msg.workdir);
      const hash = await git.commit(msg.message, msg.files);
      this.send(ws, { type: 'git:committed', workdir: msg.workdir, hash });
    } catch (error) {
      this.send(ws, {
        type: 'git:error',
        workdir: msg.workdir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGitDiff(
    ws: WebSocket,
    msg: { workdir: string; filePath: string; staged: boolean }
  ): Promise<void> {
    if (!this.validateProjectWorkdir(msg.workdir)) {
      this.send(ws, { type: 'git:error', workdir: msg.workdir, error: '项目未注册' });
      return;
    }
    try {
      const git = this.getOrCreateGitService(msg.workdir);
      const diff: FileDiff = await git.getFileDiff(msg.filePath, msg.staged);
      this.send(ws, { type: 'git:diff', workdir: msg.workdir, filePath: msg.filePath, diff });
    } catch (error) {
      this.send(ws, {
        type: 'git:error',
        workdir: msg.workdir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGitFileChanges(ws: WebSocket, workdir: string): Promise<void> {
    if (!this.validateProjectWorkdir(workdir)) {
      this.send(ws, { type: 'git:error', workdir, error: '项目未注册' });
      return;
    }
    try {
      const git = this.getOrCreateGitService(workdir);
      const result: FileChangesResult = await git.getFileChanges();
      this.send(ws, { type: 'git:fileChanges', workdir, result });
    } catch (error) {
      this.send(ws, {
        type: 'git:error',
        workdir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- Command Execution ---

  private handleCommandRun(ws: WebSocket, msg: { workdir: string; command: string }): void {
    if (!this.validateProjectWorkdir(msg.workdir)) {
      this.send(ws, { type: 'error', message: '请先选择一个项目' });
      return;
    }

    const id = this.ptyManager.create(
      {
        cwd: msg.workdir,
        cols: 80,
        rows: 24,
        initialCommand: msg.command,
      },
      () => {},
      (exitCode) => {
        this.send(ws, { type: 'session:exited', sessionId: id, exitCode });
        this.removeSubscription(ws, id);
        this.remoteSessionOwners.delete(id);
      },
      null
    );

    this.remoteSessionOwners.set(id, ws);
    this.send(ws, {
      type: 'command:started',
      sessionId: id,
      workdir: msg.workdir,
      command: msg.command,
    });

    // Auto-connect to the command session
    this.handleSessionConnect(ws, id);
  }

  // --- File Browsing ---

  private handleFileList(ws: WebSocket, dirPath: string): void {
    try {
      // Security: only allow listing directories that exist
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        this.send(ws, { type: 'file:error', path: dirPath, error: '路径不存在或不是目录' });
        return;
      }

      const entries = fs
        .readdirSync(resolved, { withFileTypes: true })
        .map((entry) => {
          try {
            const fullPath = path.join(resolved, entry.name);
            const stats = fs.statSync(fullPath);
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              modified: stats.mtimeMs,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Array<{
        name: string;
        isDirectory: boolean;
        size: number;
        modified: number;
      }>;

      this.send(ws, { type: 'file:list', path: resolved, entries });
    } catch (error) {
      this.send(ws, { type: 'file:error', path: dirPath, error: '无法读取目录' });
    }
  }

  private handleFileRead(ws: WebSocket, filePath: string): void {
    try {
      const resolved = path.resolve(filePath);
      const ext = path.extname(resolved).toLowerCase();

      if (BINARY_EXTENSIONS.has(ext)) {
        this.send(ws, { type: 'file:error', path: filePath, error: '不支持读取二进制文件' });
        return;
      }

      const stats = fs.statSync(resolved);
      if (stats.size > MAX_FILE_READ_SIZE) {
        this.send(ws, { type: 'file:error', path: filePath, error: '文件过大（超过1MB）' });
        return;
      }

      const content = fs.readFileSync(resolved, 'utf-8');
      this.send(ws, { type: 'file:read', path: resolved, content });
    } catch (error) {
      this.send(ws, { type: 'file:error', path: filePath, error: '无法读取文件' });
    }
  }

  // --- Directory Browsing (Folder Picker) ---

  private handleDirRoots(ws: WebSocket): void {
    const roots: DirRoot[] = [];
    const home = homedir();
    roots.push({ name: '主目录', path: home });

    // Common user folders
    for (const [name, sub] of [
      ['桌面', 'Desktop'],
      ['文档', 'Documents'],
      ['下载', 'Downloads'],
    ] as const) {
      const p = path.join(home, sub);
      try {
        if (fs.statSync(p).isDirectory()) roots.push({ name, path: p });
      } catch {
        /* skip */
      }
    }

    // Windows: only check common drives (A-Z scan is extremely slow)
    if (process.platform === 'win32') {
      for (const letter of 'CDEFG') {
        const drive = `${letter}:\\`;
        try {
          fs.accessSync(drive, fs.constants.R_OK);
          roots.push({ name: `${letter}: 盘`, path: drive });
        } catch {
          /* skip */
        }
      }
    }

    this.send(ws, { type: 'dir:roots', roots });
  }

  private async handleDirBrowse(ws: WebSocket, dirPath: string): Promise<void> {
    try {
      const resolved = path.resolve(dirPath);
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        this.send(ws, { type: 'dir:error', error: '路径不存在或不是目录' });
        return;
      }

      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      const dirs: DirEntry[] = [];

      // Check .git for all dirs in parallel
      const checks = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map(async (entry) => {
          const fullPath = path.join(resolved, entry.name);
          try {
            await fs.promises.access(path.join(fullPath, '.git'));
            return { name: entry.name, path: fullPath, hasGit: true, hasSubdirs: true };
          } catch {
            return { name: entry.name, path: fullPath, hasGit: false, hasSubdirs: true };
          }
        });

      const results = await Promise.allSettled(checks);
      for (const r of results) {
        if (r.status === 'fulfilled') dirs.push(r.value);
      }

      // Sort: git repos first, then alphabetically
      dirs.sort((a, b) => {
        if (a.hasGit && !b.hasGit) return -1;
        if (!a.hasGit && b.hasGit) return 1;
        return a.name.localeCompare(b.name);
      });

      const parent = path.dirname(resolved);
      this.send(ws, {
        type: 'dir:browse',
        path: resolved,
        dirs,
        parent: resolved !== parent ? parent : undefined,
      });
    } catch (error) {
      this.send(ws, {
        type: 'dir:error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
