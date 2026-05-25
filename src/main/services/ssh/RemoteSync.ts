import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SyncEstimateResult,
  SyncFailureEvent,
  SyncProgress,
  SyncReconcileResult,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import type { WebContents } from 'electron';
import PQueue from 'p-queue';
import type { SFTPWrapper, Stats } from 'ssh2';
import { GitignoreFilter } from './GitignoreFilter';
import { sshConnectionPool } from './SshConnectionPool';

const DEFAULT_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB
const MIRROR_CONCURRENCY = 1;
const PROGRESS_THROTTLE_MS = 200;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MS = [500, 1500, 3000, 6000, 12000];
const RECONCILE_MAX_FILES = 20000;

// Reasons we treat a transient error as retryable instead of giving up.
const TRANSIENT_ERROR_PATTERNS = [
  /invalid handle/i,
  /channel closed/i,
  /no sftp connection available/i,
  /timeout/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /not connected/i,
  /closed before .*reply/i,
];

type SyncOperation = 'upload' | 'delete' | 'mkdir';

interface ActiveJob {
  controller: AbortController;
  partialFiles: Set<string>;
}

interface RemoteFileEntry {
  remotePath: string;
  localPath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface PendingTask {
  hostId: string;
  operation: SyncOperation;
  localPath: string;
  remotePath: string;
  attempts: number;
  enqueuedAt: number;
}

interface HostQueueState {
  pending: PendingTask[];
  // map "<op>:<remotePath>" -> task in `pending` for dedup
  pendingIndex: Map<string, PendingTask>;
  failed: PendingTask[];
  // Wallclock timer when a backoff retry is scheduled
  retryTimer: ReturnType<typeof setTimeout> | null;
  // Promise of the currently running processQueue cycle, used to await flush
  processing: Promise<void> | null;
}

const activeJobs = new Map<string, ActiveJob>();
const hostQueues = new Map<string, HostQueueState>();

let sender: WebContents | null = null;

export function setSyncSender(webContents: WebContents): void {
  sender = webContents;
}

function pushProgress(progress: SyncProgress): void {
  if (!sender || sender.isDestroyed()) return;
  sender.send(IPC_CHANNELS.SSH_SYNC_PROGRESS, progress);
}

function pushQueueStatus(hostId: string): void {
  if (!sender || sender.isDestroyed()) return;
  sender.send(IPC_CHANNELS.SSH_SYNC_QUEUE_STATUS, getQueueStatus(hostId));
}

function pushFailure(event: SyncFailureEvent): void {
  if (!sender || sender.isDestroyed()) return;
  sender.send(IPC_CHANNELS.SSH_SYNC_FAILURE, event);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function joinRemote(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/+$/, '')}/${name}`;
}

function remoteRelative(root: string, filePath: string): string {
  const normalizedRoot = root.replace(/\/+$/, '');
  if (filePath === normalizedRoot) return '';
  return filePath.slice(normalizedRoot.length + 1).replace(/\\/g, '/');
}

function isDirectoryMode(mode: number): boolean {
  return !!(mode & 0o40000);
}

function isFileMode(mode: number): boolean {
  return !!(mode & 0o100000);
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(err.message));
}

function readRemoteFile(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(remotePath);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

export async function estimate(
  hostId: string,
  remotePath: string,
  thresholdBytes = DEFAULT_THRESHOLD_BYTES
): Promise<SyncEstimateResult> {
  const client = sshConnectionPool.get(hostId);
  if (!client?.isConnected) {
    throw new Error(`SSH 主机未连接：${hostId}`);
  }

  let totalBytes: number | null = null;
  let totalFiles: number | null = null;
  const quotedRemotePath = shellQuote(remotePath);

  try {
    const { stdout, exitCode } = await client.exec(`du -sb -- ${quotedRemotePath}`);
    if (exitCode === 0 && stdout.trim()) {
      const match = stdout.trim().match(/^(\d+)/);
      if (match) totalBytes = Number.parseInt(match[1], 10);
    }
  } catch {
    // du -sb not available
  }

  if (totalBytes === null) {
    try {
      const { stdout, exitCode } = await client.exec(`du -sk -- ${quotedRemotePath}`);
      if (exitCode === 0 && stdout.trim()) {
        const match = stdout.trim().match(/^(\d+)/);
        if (match) totalBytes = Number.parseInt(match[1], 10) * 1024;
      }
    } catch {
      // du not available
    }
  }

  try {
    const { stdout, exitCode } = await client.exec(
      `find ${quotedRemotePath} -type f 2>/dev/null | wc -l`
    );
    if (exitCode === 0) {
      totalFiles = Number.parseInt(stdout.trim(), 10);
    }
  } catch {
    // find not available
  }

  if (totalBytes === null) {
    throw new Error('无法估算远程目录大小：远程系统不可用 du 命令');
  }

  return {
    totalBytes,
    totalFiles: totalFiles ?? 0,
    tooLarge: totalBytes > thresholdBytes,
    thresholdBytes,
  };
}

export async function mirror(
  hostId: string,
  remotePath: string,
  localPath: string
): Promise<{ jobId: string }> {
  const client = sshConnectionPool.get(hostId);
  if (!client?.isConnected) {
    throw new Error(`SSH 主机未连接：${hostId}`);
  }

  const jobId = `mirror-${hostId}-${Date.now()}`;
  const activeJob: ActiveJob = { controller: new AbortController(), partialFiles: new Set() };
  activeJobs.set(jobId, activeJob);

  let sftp = await client.sftp();
  const filter = new GitignoreFilter(remotePath);
  fs.mkdirSync(localPath, { recursive: true });

  let transferredFiles = 0;
  let transferredBytes = 0;
  let lastProgressTime = 0;
  let totalBytes = 0;
  let totalFiles = 0;

  const emitProgress = (currentFile: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
    lastProgressTime = now;

    pushProgress({
      jobId,
      phase: 'mirror',
      totalBytes,
      transferredBytes,
      totalFiles,
      transferredFiles,
      currentFile,
      percent:
        totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 100,
    });
  };

  // Retry SFTP operations on stale handle errors
  const withSftpRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err: unknown) {
      if (err instanceof Error && /invalid handle/i.test(err.message)) {
        client.invalidateSftpCache();
        sftp = await client.sftp();
        return fn();
      }
      throw err;
    }
  };

  const scanDir = async (remoteDir: string): Promise<RemoteFileEntry[]> => {
    if (activeJob.controller.signal.aborted) return [];

    const entries = await withSftpRetry(
      () =>
        new Promise<
          {
            filename: string;
            longname: string;
            attrs: { size: number; mtime: number; mode: number };
          }[]
        >((resolve, reject) => {
          sftp.readdir(remoteDir, (err, list) => {
            if (err) reject(err);
            else resolve(list);
          });
        })
    );

    const dirRelative = remoteRelative(remotePath, remoteDir);
    const gitignoreEntry = entries.find((entry) => entry.filename === '.gitignore');
    if (gitignoreEntry && isFileMode(gitignoreEntry.attrs.mode ?? 0)) {
      try {
        filter.addGitignore(
          dirRelative,
          await readRemoteFile(sftp, joinRemote(remoteDir, '.gitignore'))
        );
      } catch {
        // Ignore unreadable .gitignore files and continue mirroring.
      }
    }

    const files: RemoteFileEntry[] = [];

    for (const entry of entries) {
      if (activeJob.controller.signal.aborted) break;

      const remoteFilePath = joinRemote(remoteDir, entry.filename);
      const relativePath = remoteRelative(remotePath, remoteFilePath);
      const mode = entry.attrs.mode ?? 0;
      const isDir = isDirectoryMode(mode);
      const isFile = isFileMode(mode);

      if (filter.shouldIgnore(relativePath, isDir)) continue;

      const localFilePath = path.join(localPath, ...relativePath.split('/'));
      if (isDir) {
        files.push(...(await scanDir(remoteFilePath)));
      } else if (isFile) {
        files.push({
          remotePath: remoteFilePath,
          localPath: localFilePath,
          relativePath,
          size: entry.attrs.size ?? 0,
          mtimeMs: (entry.attrs.mtime ?? 0) * 1000,
        });
      }
    }

    return files;
  };

  const downloadFile = async (file: RemoteFileEntry) => {
    if (activeJob.controller.signal.aborted) return;

    if (fs.existsSync(file.localPath)) {
      const stat = fs.statSync(file.localPath);
      if (stat.mtimeMs >= file.mtimeMs && stat.size === file.size) {
        transferredFiles++;
        transferredBytes += file.size;
        emitProgress(file.relativePath);
        return;
      }
    }

    fs.mkdirSync(path.dirname(file.localPath), { recursive: true });
    activeJob.partialFiles.add(file.localPath);

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(file.localPath);
      const readStream = sftp.createReadStream(file.remotePath);

      readStream.on('data', (chunk: Buffer) => {
        transferredBytes += chunk.length;
        emitProgress(file.relativePath);
      });

      readStream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      readStream.on('error', reject);

      const onAbort = () => {
        readStream.destroy();
        writeStream.destroy();
        reject(new Error('已取消'));
      };
      activeJob.controller.signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => activeJob.controller.signal.removeEventListener('abort', onAbort);
      writeStream.on('finish', cleanup);
      writeStream.on('error', cleanup);
      readStream.on('error', cleanup);
    });

    activeJob.partialFiles.delete(file.localPath);

    if (file.mtimeMs > 0) {
      fs.utimesSync(file.localPath, new Date(), new Date(file.mtimeMs));
    }

    transferredFiles++;
    emitProgress(file.relativePath);
  };

  try {
    pushProgress({
      jobId,
      phase: 'estimate',
      totalBytes: 0,
      transferredBytes: 0,
      totalFiles: 0,
      transferredFiles: 0,
      percent: 0,
    });

    const files = await scanDir(remotePath.replace(/\/+$/, '') || '/');
    totalFiles = files.length;
    totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    emitProgress('', true);

    const queue = new PQueue({ concurrency: MIRROR_CONCURRENCY });
    await Promise.all(files.map((file) => queue.add(() => downloadFile(file))));

    if (activeJob.controller.signal.aborted) {
      throw new Error('已取消');
    }

    transferredFiles = totalFiles;
    transferredBytes = totalBytes;
    emitProgress('', true);
  } finally {
    activeJobs.delete(jobId);
  }

  // Write metadata so sync can find the remote mapping even after restart
  fs.writeFileSync(
    path.join(localPath, '.enso-remote.json'),
    JSON.stringify({ hostId, remotePath }, null, 2),
    'utf-8'
  );

  return { jobId };
}

export function cancel(jobId: string): void {
  const activeJob = activeJobs.get(jobId);
  if (!activeJob) return;

  activeJob.controller.abort();
  for (const partialFile of activeJob.partialFiles) {
    try {
      fs.rmSync(partialFile, { force: true });
    } catch {
      // Best-effort partial cleanup
    }
  }
  activeJobs.delete(jobId);
}

// ----- Remote primitives (low-level SFTP helpers) --------------------------

const remoteDirCache = new Map<string, Set<string>>();

function dirCacheFor(hostId: string): Set<string> {
  let cache = remoteDirCache.get(hostId);
  if (!cache) {
    cache = new Set();
    remoteDirCache.set(hostId, cache);
  }
  return cache;
}

function invalidateDirCache(hostId: string): void {
  remoteDirCache.delete(hostId);
}

function sftpMkdir(sftp: SFTPWrapper, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dir, (err) => {
      if (!err) return resolve();
      const sftpErr = err as Error & { code?: number | string };
      // SFTP code 4 (failure) is typically EEXIST; ssh2 also signals via code === 11 (FX_FILE_ALREADY_EXISTS)
      if (
        sftpErr.code === 4 ||
        sftpErr.code === 11 ||
        /already exists|file exists/i.test(err.message)
      ) {
        return resolve();
      }
      reject(err);
    });
  });
}

function sftpStat(sftp: SFTPWrapper, target: string): Promise<Stats | null> {
  return new Promise((resolve) => {
    sftp.stat(target, (err, attrs) => {
      if (err) resolve(null);
      else resolve(attrs);
    });
  });
}

function sftpUnlink(sftp: SFTPWrapper, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(target, (err) => {
      if (!err) return resolve();
      const sftpErr = err as Error & { code?: number | string };
      // SFTP code 2 = SSH_FX_NO_SUCH_FILE — treat as success (idempotent)
      if (sftpErr.code === 2 || /no such file/i.test(err.message)) {
        return resolve();
      }
      reject(err);
    });
  });
}

function sftpRmdir(sftp: SFTPWrapper, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(target, (err) => {
      if (!err) return resolve();
      const sftpErr = err as Error & { code?: number | string };
      if (sftpErr.code === 2 || /no such file/i.test(err.message)) {
        return resolve();
      }
      reject(err);
    });
  });
}

async function ensureRemoteDir(
  hostId: string,
  sftp: SFTPWrapper,
  remoteDir: string
): Promise<void> {
  const normalized = remoteDir.replace(/\/+$/, '');
  if (!normalized || normalized === '/' || normalized === '.') return;

  const cache = dirCacheFor(hostId);
  if (cache.has(normalized)) return;

  // Try the leaf first — most often the parent already exists.
  try {
    await sftpMkdir(sftp, normalized);
    cache.add(normalized);
    return;
  } catch (err) {
    const sftpErr = err as Error & { code?: number | string };
    // Parent missing — recurse, then retry. SFTP code 2 = NO_SUCH_FILE.
    if (sftpErr.code !== 2 && !/no such file|not a directory/i.test((err as Error).message)) {
      throw err;
    }
  }

  const parent = normalized.replace(/\/[^/]+$/, '');
  await ensureRemoteDir(hostId, sftp, parent || '/');
  await sftpMkdir(sftp, normalized);
  cache.add(normalized);
}

async function uploadFileStream(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);

    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    writeStream.on('close', () => finish());
    writeStream.on('error', finish);
    readStream.on('error', finish);
    readStream.pipe(writeStream);
  });
}

/**
 * Low-level upload. Used by mirror() and by the sync queue.
 * Does NOT recurse into the queue — it just performs one SFTP write.
 * The queue layer above handles retries, parent-dir creation, and dedup.
 */
export async function upload(hostId: string, localPath: string, remotePath: string): Promise<void> {
  const client = sshConnectionPool.get(hostId);
  if (!client?.isConnected) {
    throw new Error(`SSH 主机未连接：${hostId}`);
  }

  const sftp = await client.sftp();
  const remoteDir = remotePath.replace(/\/[^/]+$/, '');
  await ensureRemoteDir(hostId, sftp, remoteDir || '/');
  await uploadFileStream(sftp, localPath, remotePath);
}

// ----- Queue layer ---------------------------------------------------------

function queueFor(hostId: string): HostQueueState {
  let queue = hostQueues.get(hostId);
  if (!queue) {
    queue = {
      pending: [],
      pendingIndex: new Map(),
      failed: [],
      retryTimer: null,
      processing: null,
    };
    hostQueues.set(hostId, queue);
  }
  return queue;
}

function taskKey(task: Pick<PendingTask, 'operation' | 'remotePath'>): string {
  return `${task.operation}:${task.remotePath}`;
}

function enqueueTask(task: PendingTask): void {
  const state = queueFor(task.hostId);
  const key = taskKey(task);
  const existing = state.pendingIndex.get(key);
  if (existing) {
    // Coalesce: update enqueuedAt and localPath (mtime/size may differ on later writes).
    existing.localPath = task.localPath;
    existing.enqueuedAt = task.enqueuedAt;
    // Don't reset attempts — preserve retry count to avoid infinite loops on a perpetually broken file.
    return;
  }
  state.pending.push(task);
  state.pendingIndex.set(key, task);
  pushQueueStatus(task.hostId);
  void processQueue(task.hostId);
}

export function enqueueUpload(hostId: string, localPath: string, remotePath: string): void {
  enqueueTask({
    hostId,
    operation: 'upload',
    localPath,
    remotePath,
    attempts: 0,
    enqueuedAt: Date.now(),
  });
}

export function enqueueDelete(hostId: string, remotePath: string): void {
  enqueueTask({
    hostId,
    operation: 'delete',
    localPath: '',
    remotePath,
    attempts: 0,
    enqueuedAt: Date.now(),
  });
}

export function retryPendingUploads(hostId: string): void {
  // Move all failed tasks back to pending (reset attempts) and kick the queue.
  const state = queueFor(hostId);
  for (const task of state.failed) {
    task.attempts = 0;
    const key = taskKey(task);
    if (!state.pendingIndex.has(key)) {
      state.pending.push(task);
      state.pendingIndex.set(key, task);
    }
  }
  state.failed = [];
  pushQueueStatus(hostId);
  void processQueue(hostId);
}

async function executeTask(task: PendingTask): Promise<void> {
  const client = sshConnectionPool.get(task.hostId);
  if (!client?.isConnected) {
    throw new Error(`SSH 主机未连接：${task.hostId}`);
  }

  if (task.operation === 'upload') {
    // The local file may have been deleted between enqueue and now.
    if (!fs.existsSync(task.localPath)) return;

    try {
      const sftp = await client.sftp();
      const remoteDir = task.remotePath.replace(/\/[^/]+$/, '');
      await ensureRemoteDir(task.hostId, sftp, remoteDir || '/');
      await uploadFileStream(sftp, task.localPath, task.remotePath);
    } catch (err) {
      // Stale SFTP handle — invalidate and retry once inside this attempt.
      if (err instanceof Error && /invalid handle|channel closed/i.test(err.message)) {
        client.invalidateSftpCache();
        invalidateDirCache(task.hostId);
        const sftp = await client.sftp();
        const remoteDir = task.remotePath.replace(/\/[^/]+$/, '');
        await ensureRemoteDir(task.hostId, sftp, remoteDir || '/');
        await uploadFileStream(sftp, task.localPath, task.remotePath);
      } else {
        throw err;
      }
    }
    return;
  }

  if (task.operation === 'delete') {
    const sftp = await client.sftp();
    const stats = await sftpStat(sftp, task.remotePath);
    if (!stats) return; // already gone
    if (isDirectoryMode(stats.mode ?? 0)) {
      await sftpRmdir(sftp, task.remotePath);
    } else {
      await sftpUnlink(sftp, task.remotePath);
    }
    return;
  }

  if (task.operation === 'mkdir') {
    const sftp = await client.sftp();
    await ensureRemoteDir(task.hostId, sftp, task.remotePath);
    return;
  }
}

function processQueue(hostId: string): Promise<void> {
  const state = queueFor(hostId);
  if (state.processing) return state.processing;

  const run = (async () => {
    while (state.pending.length > 0) {
      const task = state.pending[0];
      if (!task) break;

      const client = sshConnectionPool.get(hostId);
      if (!client?.isConnected) {
        // Offline — leave queue intact; SSH reconnect will call retryPendingUploads()
        pushQueueStatus(hostId);
        break;
      }

      try {
        await executeTask(task);
        state.pending.shift();
        state.pendingIndex.delete(taskKey(task));
        pushQueueStatus(hostId);
      } catch (err) {
        task.attempts++;
        const willRetry = task.attempts < MAX_RETRIES;
        const transient = isTransientError(err);
        const errorMessage = err instanceof Error ? err.message : String(err);

        pushFailure({
          hostId: task.hostId,
          localPath: task.localPath,
          remotePath: task.remotePath,
          operation: task.operation,
          error: errorMessage,
          attempts: task.attempts,
          willRetry,
        });

        if (willRetry) {
          // Keep the task in pending; schedule a backoff.
          // For transient errors, also kick a connect-state recheck.
          const backoff =
            RETRY_BACKOFF_MS[Math.min(task.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, backoff);
            state.retryTimer = timer;
          });
          state.retryTimer = null;
          if (transient) {
            const c = sshConnectionPool.get(hostId);
            if (!c?.isConnected) break; // hand off to reconnect-driven retry
          }
          continue; // retry the same task
        }

        // Exhausted retries → failed queue
        state.pending.shift();
        state.pendingIndex.delete(taskKey(task));
        state.failed.push(task);
        pushQueueStatus(hostId);
        console.warn(
          `[RemoteSync] ${task.operation} failed permanently: ${task.remotePath} (${errorMessage})`
        );
      }
    }
  })();

  state.processing = run.finally(() => {
    state.processing = null;
  });
  return state.processing;
}

export function getQueueStatus(hostId: string): {
  hostId: string;
  pending: number;
  failed: number;
  isOnline: boolean;
} {
  const state = queueFor(hostId);
  const client = sshConnectionPool.get(hostId);
  return {
    hostId,
    pending: state.pending.length,
    failed: state.failed.length,
    isOnline: client?.isConnected ?? false,
  };
}

export function flushSyncQueue(timeoutMs = 8000): Promise<void> {
  const totalPending = () =>
    Array.from(hostQueues.values()).reduce((sum, state) => sum + state.pending.length, 0);
  if (totalPending() === 0) return Promise.resolve();

  for (const hostId of hostQueues.keys()) {
    void processQueue(hostId);
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (totalPending() === 0 || Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}

// ----- Reconcile: local → remote diff (safety net for missed events) ------

interface ReconcileOptions {
  /** When true, also enqueue deletes for files that exist remotely but not locally. */
  deleteExtraneous?: boolean;
  /** Skip patterns relative to localPath root. Default: node_modules, .git. */
  skipDirs?: string[];
}

const DEFAULT_RECONCILE_SKIP_DIRS = ['node_modules', '.git', '.enso-cache'];

/**
 * Walk the local directory tree, compare each file's mtime/size against the remote,
 * and enqueue an upload for every mismatch. This is the reliable safety net that
 * guarantees no AI-edited file is left behind — even if @parcel/watcher drops events,
 * even if the app was closed mid-edit, this catches it.
 */
export async function reconcile(
  hostId: string,
  localPath: string,
  remotePath: string,
  options: ReconcileOptions = {}
): Promise<SyncReconcileResult> {
  const start = Date.now();
  const client = sshConnectionPool.get(hostId);
  if (!client?.isConnected) {
    throw new Error(`SSH 主机未连接：${hostId}`);
  }

  const sftp = await client.sftp();
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_RECONCILE_SKIP_DIRS);
  const localRoot = path.resolve(localPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const remoteRoot = remotePath.replace(/\/+$/, '');

  let scanned = 0;
  let uploaded = 0;
  let deleted = 0;
  let skipped = 0;
  let truncated = false;

  // Snapshot remote tree (single SSH find call — much faster than per-file SFTP stat).
  // Format: "<mtime> <size> <path>\n", path is absolute on the remote.
  const remoteIndex = new Map<string, { mtimeMs: number; size: number }>();
  try {
    const findCmd = `find ${shellQuote(remoteRoot)} -type f -printf '%T@ %s %p\\n' 2>/dev/null`;
    const { stdout, exitCode } = await client.exec(findCmd);
    if (exitCode === 0) {
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const m = line.match(/^([\d.]+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const mtimeMs = Math.floor(Number.parseFloat(m[1]) * 1000);
        const size = Number.parseInt(m[2], 10);
        const fullPath = m[3];
        if (!fullPath.startsWith(`${remoteRoot}/`) && fullPath !== remoteRoot) continue;
        remoteIndex.set(fullPath, { mtimeMs, size });
      }
    }
  } catch {
    // remote `find` unavailable — fall back to per-file SFTP stat below
  }

  // BFS local tree
  const stack: string[] = [localRoot];
  const visitedRemote = new Set<string>();

  while (stack.length > 0) {
    if (scanned >= RECONCILE_MAX_FILES) {
      truncated = true;
      break;
    }

    const dir = stack.pop();
    if (!dir) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scanned >= RECONCILE_MAX_FILES) {
        truncated = true;
        break;
      }

      const fullLocal = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push(fullLocal);
        continue;
      }

      if (!entry.isFile()) continue;
      if (entry.name === '.enso-remote.json') continue;

      scanned++;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullLocal);
      } catch {
        continue;
      }

      const rel = path.relative(localRoot, fullLocal).replace(/\\/g, '/');
      const remoteFilePath = `${remoteRoot}/${rel}`;
      visitedRemote.add(remoteFilePath);

      let remoteMeta = remoteIndex.get(remoteFilePath);
      if (!remoteMeta && remoteIndex.size === 0) {
        // Fallback: per-file stat when remote `find` failed.
        const attrs = await sftpStat(sftp, remoteFilePath);
        if (attrs && isFileMode(attrs.mode ?? 0)) {
          remoteMeta = { mtimeMs: (attrs.mtime ?? 0) * 1000, size: attrs.size ?? 0 };
        }
      }

      // Upload if missing remotely, size differs, or local mtime is newer
      // (allow 2s slack to absorb SFTP's 1-second mtime resolution).
      const needUpload =
        !remoteMeta || remoteMeta.size !== stat.size || stat.mtimeMs - remoteMeta.mtimeMs > 2000;

      if (needUpload) {
        enqueueUpload(hostId, fullLocal, remoteFilePath);
        uploaded++;
      } else {
        skipped++;
      }
    }
  }

  // Optional: delete remote files that no longer exist locally.
  if (options.deleteExtraneous && remoteIndex.size > 0) {
    for (const remoteFilePath of remoteIndex.keys()) {
      if (!visitedRemote.has(remoteFilePath)) {
        // Don't delete .gitignore'd / hidden files speculatively — only enqueue when local clearly removed.
        const rel = remoteFilePath.slice(remoteRoot.length + 1);
        const localCounterpart = path.join(localRoot, ...rel.split('/'));
        if (!fs.existsSync(localCounterpart)) {
          enqueueDelete(hostId, remoteFilePath);
          deleted++;
        }
      }
    }
  }

  return {
    hostId,
    localPath: localRoot,
    remotePath: remoteRoot,
    scanned,
    uploaded,
    deleted,
    skipped,
    durationMs: Date.now() - start,
    truncated,
  };
}

/**
 * Run reconcile for a local directory by reading its .enso-remote.json metadata.
 * Designed to be called from agent Stop hooks (Claude / Codex / Gemini etc.)
 * Returns 0 silently when the directory is not a remote-cache project.
 */
export async function reconcileLocalDir(localDir: string): Promise<number> {
  let mirrorRoot = localDir;
  while (!fs.existsSync(path.join(mirrorRoot, '.enso-remote.json'))) {
    const parent = path.dirname(mirrorRoot);
    if (parent === mirrorRoot) return 0;
    mirrorRoot = parent;
  }

  let meta: { hostId: string; remotePath: string };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(mirrorRoot, '.enso-remote.json'), 'utf-8'));
  } catch {
    return 0;
  }

  const client = sshConnectionPool.get(meta.hostId);
  if (!client?.isConnected) return 0;

  try {
    const result = await reconcile(meta.hostId, mirrorRoot, meta.remotePath);
    return result.uploaded;
  } catch (err) {
    console.warn('[RemoteSync] reconcileLocalDir failed:', (err as Error).message);
    return 0;
  }
}

/**
 * @deprecated Use reconcileLocalDir instead. Kept as a thin wrapper for backward compatibility.
 */
export const syncLocalDirToRemote = reconcileLocalDir;
