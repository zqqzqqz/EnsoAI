import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { RemoteHost, SshConnectionStatus, SshErrorCode } from '@shared/types';
import { type HostKeyVerifyDecision, type HostKeyVerifyRequest, IPC_CHANNELS } from '@shared/types';
import type { WebContents } from 'electron';
import { BrowserWindow, dialog } from 'electron';
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import { Client } from 'ssh2';
import { knownHostsStore } from './KnownHostsStore';

export type SshClientEvents = {
  ready: [];
  error: [error: SshClientError];
  close: [];
  statusChange: [status: SshConnectionStatus];
};

const CONNECT_TIMEOUT_MS = 15_000;
const VERIFY_KEY_TIMEOUT_MS = 60_000;

let verifyKeySender: WebContents | null = null;
const pendingVerifyKeyDecisions = new Map<
  string,
  {
    resolve: (decision: HostKeyVerifyDecision) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

export function setHostKeyVerifySender(sender: WebContents | null): void {
  verifyKeySender = sender;
}

export function resolveVerifyKeyDecision(hostId: string, decision: HostKeyVerifyDecision): void {
  const pending = pendingVerifyKeyDecisions.get(hostId);
  if (!pending) return;

  pendingVerifyKeyDecisions.delete(hostId);
  clearTimeout(pending.timer);
  pending.resolve(decision);
}

async function requestVerifyKeyDecision(req: HostKeyVerifyRequest): Promise<HostKeyVerifyDecision> {
  const message = req.isChanged
    ? `SSH 主机 ${req.hostname}:${req.port} 的主机密钥已变更。\n\n类型：${req.keyType}\n指纹：${req.fingerprint}\n\n如果你不确定这是预期变更，请选择拒绝。`
    : `首次连接 SSH 主机 ${req.hostname}:${req.port}。\n\n类型：${req.keyType}\n指纹：${req.fingerprint}\n\n是否信任并保存该主机密钥？`;

  if (!verifyKeySender || verifyKeySender.isDestroyed()) {
    const result = await dialog.showMessageBox({
      type: req.isChanged ? 'warning' : 'question',
      buttons: ['拒绝', '信任'],
      defaultId: 0,
      cancelId: 0,
      title: req.isChanged ? 'SSH 主机密钥已变更' : '信任 SSH 主机密钥',
      message,
      noLink: true,
    });
    return result.response === 1 ? 'accept' : 'reject';
  }

  const existing = pendingVerifyKeyDecisions.get(req.hostId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject(new Error('新的主机密钥验证请求已替代当前请求'));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingVerifyKeyDecisions.delete(req.hostId);
      reject(new Error('主机密钥验证超时'));
    }, VERIFY_KEY_TIMEOUT_MS);

    const webContents = verifyKeySender;
    if (!webContents || webContents.isDestroyed()) {
      clearTimeout(timer);
      resolve('reject');
      return;
    }

    pendingVerifyKeyDecisions.set(req.hostId, { resolve, reject, timer });
    webContents.send(IPC_CHANNELS.SSH_HOST_VERIFY_KEY_REQUEST, req);

    const owner = BrowserWindow.fromWebContents(webContents);
    const showMessageBox = owner
      ? dialog.showMessageBox(owner, {
          type: req.isChanged ? 'warning' : 'question',
          buttons: ['拒绝', '信任'],
          defaultId: 0,
          cancelId: 0,
          title: req.isChanged ? 'SSH 主机密钥已变更' : '信任 SSH 主机密钥',
          message,
          noLink: true,
        })
      : dialog.showMessageBox({
          type: req.isChanged ? 'warning' : 'question',
          buttons: ['拒绝', '信任'],
          defaultId: 0,
          cancelId: 0,
          title: req.isChanged ? 'SSH 主机密钥已变更' : '信任 SSH 主机密钥',
          message,
          noLink: true,
        });

    showMessageBox
      .then((result) => {
        resolveVerifyKeyDecision(req.hostId, result.response === 1 ? 'accept' : 'reject');
      })
      .catch((error) => {
        pendingVerifyKeyDecisions.delete(req.hostId);
        clearTimeout(timer);
        reject(error);
      });
  });
}

function parseHostKeyType(key: Buffer): string {
  if (key.length < 4) return 'unknown';

  const length = key.readUInt32BE(0);
  if (length <= 0 || length > key.length - 4) return 'unknown';

  return key.subarray(4, 4 + length).toString('utf8');
}

function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function withDetail(message: string, err: Error): string {
  return `${message}：${err.message}`;
}

function toSshClientError(message: string, code: SshErrorCode, err: Error): SshClientError {
  return new SshClientError(withDetail(message, err), code);
}

export class SshClientError extends Error {
  constructor(
    message: string,
    public readonly code: SshErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'SshClientError';
  }
}

export interface SshClientConnectOptions {
  host: RemoteHost;
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
}

type Resolvers<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type Ssh2Error = Error & { code?: string | number; level?: string };

export class SshClient extends EventEmitter {
  private client: Client | null = null;
  private sftpCache: SFTPWrapper | null = null;
  private _status: SshConnectionStatus = 'idle';
  private _host: RemoteHost | null = null;
  private hostKeyFailureCode: SshErrorCode | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in connect()
  private connectResolvers: Resolvers<void> | null = null;

  get status(): SshConnectionStatus {
    return this._status;
  }

  get host(): RemoteHost | null {
    return this._host;
  }

  get isConnected(): boolean {
    return this._status === 'connected';
  }

  private setStatus(status: SshConnectionStatus): void {
    this._status = status;
    this.emit('statusChange', status);
  }

  private emitError(error: SshClientError): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  async connect(options: SshClientConnectOptions): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      throw new SshClientError('SSH 连接已建立或正在连接中', 'UNKNOWN');
    }

    this._host = options.host;
    this.hostKeyFailureCode = null;
    this.setStatus('connecting');
    this.sftpCache = null;

    const client = new Client();
    this.client = client;

    const connectConfig: ConnectConfig = {
      host: options.host.host,
      port: options.host.port,
      username: options.host.user,
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer, verify: (permitted: boolean) => void) => {
        this.verifyHostKey(options.host, key as Buffer)
          .then((accepted) => verify(accepted))
          .catch(() => verify(false));
        return undefined;
      },
    };

    if (options.privateKey) {
      connectConfig.privateKey = options.privateKey;
      if (options.passphrase) {
        connectConfig.passphrase = options.passphrase;
      }
    } else if (options.password) {
      connectConfig.password = options.password;
    }

    return new Promise<void>((resolve, reject) => {
      this.connectResolvers = { resolve, reject };
      let settled = false;

      const removeConnectListeners = (): void => {
        client.removeListener('ready', onReady);
        this.connectResolvers = null;
      };

      const removeAllListeners = (): void => {
        removeConnectListeners();
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
      };

      const handleError = (err: Error): SshClientError => {
        const sshError = this.classifyError(err);
        this.sftpCache = null;
        this.setStatus('error');
        this.emitError(sshError);
        return sshError;
      };

      const onReady = (): void => {
        settled = true;
        removeConnectListeners();
        this.setStatus('connected');
        this.emit('ready');
        resolve();
      };

      const onError = (err: Error): void => {
        const sshError = handleError(err);
        if (!settled) {
          settled = true;
          removeAllListeners();
          reject(sshError);
          return;
        }
        client.destroy();
      };

      const onClose = (): void => {
        this.sftpCache = null;
        if (!settled) {
          settled = true;
          removeAllListeners();
          if (this._status === 'connecting') {
            reject(
              new SshClientError(
                'SSH 握手期间连接已关闭',
                this.hostKeyFailureCode ?? 'NETWORK_UNREACHABLE'
              )
            );
          }
        }
        if (this._status !== 'error') {
          this.setStatus('disconnected');
        }
        this.emit('close');
      };

      client.once('ready', onReady);
      client.on('error', onError);
      client.on('close', onClose);

      try {
        client.connect(connectConfig);
      } catch (err) {
        settled = true;
        removeAllListeners();
        reject(new SshClientError(withDetail('启动 SSH 连接失败', err as Error), 'UNKNOWN'));
      }
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client || this._status === 'idle' || this._status === 'disconnected') {
      return;
    }

    this.setStatus('disconnecting');
    this.sftpCache = null;

    return new Promise<void>((resolve) => {
      if (!this.client) {
        this.setStatus('disconnected');
        resolve();
        return;
      }

      this.client.once('close', () => {
        this.setStatus('disconnected');
        resolve();
      });

      this.client.end();
    });
  }

  exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }> {
    return new Promise((resolve, reject) => {
      this.assertConnected();

      const execOpts: Record<string, unknown> = {};
      if (options?.cwd) execOpts.cwd = options.cwd;
      if (options?.env) execOpts.env = options.env;

      this.client!.exec(command, execOpts, (err, stream) => {
        if (err) {
          reject(new SshClientError(withDetail('执行远程命令失败', err), 'UNKNOWN'));
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });
        stream.on('close', (exitCode: number | null) => {
          resolve({ stdout, stderr, exitCode });
        });
      });
    });
  }

  shell(opts?: { cols?: number; rows?: number; term?: string }): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.assertConnected();

      const windowOpts = {
        cols: opts?.cols ?? 80,
        rows: opts?.rows ?? 24,
        term: opts?.term ?? 'xterm-256color',
      };

      this.client!.shell(
        { term: windowOpts.term, cols: windowOpts.cols, rows: windowOpts.rows },
        (err, stream) => {
          if (err) {
            reject(new SshClientError(withDetail('创建 SSH 终端失败', err), 'UNKNOWN'));
            return;
          }
          resolve(stream);
        }
      );
    });
  }

  async sftp(): Promise<SFTPWrapper> {
    this.assertConnected();

    if (this.sftpCache) {
      return this.sftpCache;
    }

    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          reject(new SshClientError(withDetail('创建 SFTP 会话失败', err), 'UNKNOWN'));
          return;
        }
        // Clear cache when the SFTP channel closes independently of SSH transport
        sftp.on('close', () => {
          if (this.sftpCache === sftp) {
            this.sftpCache = null;
          }
        });
        this.sftpCache = sftp;
        resolve(sftp);
      });
    });
  }

  invalidateSftpCache(): void {
    this.sftpCache = null;
  }

  destroy(): void {
    if (this.client) {
      try {
        this.client.destroy();
      } catch {
        // Best-effort cleanup
      }
      this.client = null;
      this.sftpCache = null;
    }
    this.setStatus('disconnected');
  }

  private async verifyHostKey(host: RemoteHost, key: Buffer): Promise<boolean> {
    const keyType = parseHostKeyType(key);
    const fingerprint = fingerprintHostKey(key);
    const result = knownHostsStore.verify(host.host, host.port, keyType, fingerprint);

    if (result.known && result.matched) return true;

    this.hostKeyFailureCode = result.known ? 'HOST_KEY_MISMATCH' : 'HOST_KEY_UNKNOWN';
    const decision = await requestVerifyKeyDecision({
      hostId: host.id,
      hostname: host.host,
      port: host.port,
      keyType,
      fingerprint,
      isChanged: result.known,
    });

    if (decision !== 'accept') return false;

    knownHostsStore.add(host.host, host.port, keyType, fingerprint);
    this.hostKeyFailureCode = null;
    return true;
  }

  private assertConnected(): void {
    if (!this.client || this._status !== 'connected') {
      throw new SshClientError('SSH 未连接', 'NETWORK_UNREACHABLE');
    }
  }

  private classifyError(err: Error): SshClientError {
    const sshErr = err as Ssh2Error;
    const msg = err.message.toLowerCase();

    if (this.hostKeyFailureCode) {
      const message =
        this.hostKeyFailureCode === 'HOST_KEY_MISMATCH'
          ? 'SSH 主机密钥已变更'
          : 'SSH 主机密钥未信任';
      return toSshClientError(message, this.hostKeyFailureCode, err);
    }
    if (sshErr.level === 'client-authentication') {
      return toSshClientError('SSH 认证失败', 'AUTH_FAILED', err);
    }
    if (sshErr.level === 'client-timeout') {
      return toSshClientError('SSH 连接超时', 'TIMEOUT', err);
    }
    if (sshErr.level === 'client-dns' || sshErr.level === 'client-socket') {
      const code = typeof sshErr.code === 'string' ? sshErr.code.toLowerCase() : '';
      if (code === 'econnrefused') {
        return toSshClientError('SSH 连接被拒绝', 'CONNECTION_REFUSED', err);
      }
      return toSshClientError('无法连接 SSH 主机', 'NETWORK_UNREACHABLE', err);
    }
    if (sshErr.level === 'handshake' && msg.includes('host denied')) {
      return toSshClientError('SSH 主机密钥未信任', 'HOST_KEY_UNKNOWN', err);
    }

    if (
      msg.includes('auth') ||
      msg.includes('password') ||
      msg.includes('permission denied') ||
      msg.includes('private key')
    ) {
      return toSshClientError('SSH 认证失败', 'AUTH_FAILED', err);
    }
    if (msg.includes('host key') || msg.includes('fingerprint')) {
      return toSshClientError('SSH 主机密钥不匹配', 'HOST_KEY_MISMATCH', err);
    }
    if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('etimedout')) {
      return toSshClientError('SSH 连接超时', 'TIMEOUT', err);
    }
    if (msg.includes('econnrefused') || msg.includes('refused')) {
      return toSshClientError('SSH 连接被拒绝', 'CONNECTION_REFUSED', err);
    }
    if (
      msg.includes('enotfound') ||
      msg.includes('econnreset') ||
      msg.includes('unreachable') ||
      msg.includes('enetunreach')
    ) {
      return toSshClientError('无法连接 SSH 主机', 'NETWORK_UNREACHABLE', err);
    }

    return toSshClientError('SSH 连接失败', 'UNKNOWN', err);
  }
}
