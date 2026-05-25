// SSH remote development types — shared between main / preload / renderer.

export type RemoteHostAuthType = 'password' | 'privateKey';

export interface RemoteHost {
  id: string;
  alias: string;
  host: string;
  port: number;
  user: string;
  authType: RemoteHostAuthType;
  privateKeyPath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteHostCredentialMeta {
  hostId: string;
  hasPassword: boolean;
  hasPassphrase: boolean;
}

export type SshConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

export interface SshConnectionState {
  hostId: string;
  status: SshConnectionStatus;
  errorCode?: SshErrorCode;
  errorMessage?: string;
  connectedAt?: number;
}

export type SshErrorCode =
  | 'AUTH_FAILED'
  | 'HOST_KEY_MISMATCH'
  | 'HOST_KEY_UNKNOWN'
  | 'NETWORK_UNREACHABLE'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'SAFE_STORAGE_UNAVAILABLE'
  | 'UNKNOWN';

export interface SshTestConnectionResult {
  ok: boolean;
  serverVersion?: string;
  errorCode?: SshErrorCode;
  errorMessage?: string;
}

// SFTP entry returned by ssh:fs:readDir
export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpEntry {
  name: string;
  path: string;
  type: SftpEntryType;
  size: number;
  mtime: number;
  mode: number;
}

export interface SftpStat {
  type: SftpEntryType;
  size: number;
  mtime: number;
  mode: number;
}

// Sync engine
export type SyncJobState =
  | 'estimating'
  | 'mirroring'
  | 'idle'
  | 'uploading'
  | 'cancelled'
  | 'failed';

export interface SyncJob {
  id: string;
  hostId: string;
  remotePath: string;
  localPath: string;
  state: SyncJobState;
  createdAt: number;
}

export interface SyncProgress {
  jobId: string;
  phase: 'estimate' | 'mirror' | 'upload';
  totalBytes: number;
  transferredBytes: number;
  totalFiles: number;
  transferredFiles: number;
  currentFile?: string;
  percent: number;
}

export interface SyncEstimateResult {
  totalBytes: number;
  totalFiles: number;
  tooLarge: boolean;
  thresholdBytes: number;
}

export interface SyncQueueStatus {
  hostId: string;
  pending: number;
  failed: number;
  isOnline: boolean;
}

export interface SyncFailureEvent {
  hostId: string;
  localPath: string;
  remotePath: string;
  operation: 'upload' | 'delete' | 'mkdir';
  error: string;
  attempts: number;
  willRetry: boolean;
}

export interface SyncReconcileResult {
  hostId: string;
  localPath: string;
  remotePath: string;
  scanned: number;
  uploaded: number;
  deleted: number;
  skipped: number;
  durationMs: number;
  truncated?: boolean;
}

// Remote project metadata (registered after mirror completes)
export interface RemoteProject {
  id: string;
  hostId: string;
  remotePath: string;
  localPath: string;
  alias: string;
  openedAt: number;
}

// Host key verification request pushed to renderer when first connecting
export interface HostKeyVerifyRequest {
  hostId: string;
  hostname: string;
  port: number;
  keyType: string;
  fingerprint: string;
  isChanged: boolean;
}

export type HostKeyVerifyDecision = 'accept' | 'reject';

// IPC payload for ssh:host:save
export interface RemoteHostSaveInput {
  host: Omit<RemoteHost, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
  password?: string;
  passphrase?: string;
}
