export interface RemoteShareConfig {
  port: number;
  authToken: string;
}

export interface RemoteShareStatus {
  running: boolean;
  port?: number;
  url?: string;
  error?: string;
}

export interface RemoteShareSettings {
  enabled: boolean;
  port: number;
  authToken: string;
  boreEnabled: boolean;
  boreServer: string;
}

export interface BoreStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  url?: string;
  error?: string;
}

export interface RemoteSessionInfo {
  id: string;
  cwd: string;
  isLocal?: boolean;
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modified: number;
}

export interface ProjectInfo {
  name: string;
  path: string;
  isValid: boolean;
}

export interface DirRoot {
  name: string;
  path: string;
}

export interface DirEntry {
  name: string;
  path: string;
  hasGit: boolean;
  hasSubdirs: boolean;
}

// WebSocket protocol: Client -> Server
export type ClientMessage =
  | { type: 'session:list' }
  | { type: 'session:create'; cwd?: string; cols?: number; rows?: number }
  | { type: 'session:connect'; sessionId: string }
  | { type: 'session:disconnect'; sessionId: string }
  | { type: 'session:destroy'; sessionId: string }
  | { type: 'session:write'; sessionId: string; data: string }
  | { type: 'session:resize'; sessionId: string; cols: number; rows: number }
  | { type: 'file:list'; path: string }
  | { type: 'file:read'; path: string }
  | { type: 'project:list' }
  | { type: 'project:add'; path: string }
  | { type: 'project:remove'; path: string }
  | { type: 'git:status'; workdir: string }
  | { type: 'git:log'; workdir: string; maxCount?: number; skip?: number }
  | { type: 'git:stage'; workdir: string; paths: string[] }
  | { type: 'git:unstage'; workdir: string; paths: string[] }
  | { type: 'git:commit'; workdir: string; message: string; files?: string[] }
  | { type: 'git:diff'; workdir: string; filePath: string; staged: boolean }
  | { type: 'git:fileChanges'; workdir: string }
  | { type: 'command:run'; workdir: string; command: string }
  | { type: 'dir:roots' }
  | { type: 'dir:browse'; path: string }
  | { type: 'ping' };

// WebSocket protocol: Server -> Client
export type ServerMessage =
  | { type: 'session:list'; sessions: RemoteSessionInfo[] }
  | { type: 'session:created'; session: RemoteSessionInfo }
  | { type: 'session:connected'; sessionId: string }
  | { type: 'session:data'; sessionId: string; data: string }
  | { type: 'session:exited'; sessionId: string; exitCode: number }
  | { type: 'session:error'; sessionId?: string; error: string }
  | { type: 'file:list'; path: string; entries: FileEntry[] }
  | { type: 'file:read'; path: string; content: string }
  | { type: 'file:error'; path: string; error: string }
  | { type: 'project:list'; projects: ProjectInfo[] }
  | { type: 'project:added'; project: ProjectInfo }
  | { type: 'project:removed'; path: string }
  | { type: 'project:error'; error: string }
  | { type: 'git:status'; workdir: string; status: import('./git').GitStatus }
  | { type: 'git:log'; workdir: string; entries: import('./git').GitLogEntry[] }
  | { type: 'git:staged'; workdir: string }
  | { type: 'git:unstaged'; workdir: string }
  | { type: 'git:committed'; workdir: string; hash: string }
  | { type: 'git:diff'; workdir: string; filePath: string; diff: import('./git').FileDiff }
  | { type: 'git:fileChanges'; workdir: string; result: import('./git').FileChangesResult }
  | { type: 'git:error'; workdir: string; error: string }
  | { type: 'command:started'; sessionId: string; workdir: string; command: string }
  | { type: 'dir:roots'; roots: DirRoot[] }
  | { type: 'dir:browse'; path: string; dirs: DirEntry[]; parent?: string }
  | { type: 'dir:error'; error: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };
