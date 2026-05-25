import type { SftpEntry, SftpEntryType, SftpStat } from '@shared/types';
import type { SFTPWrapper, Stats } from 'ssh2';
import { sshConnectionPool } from './SshConnectionPool';

const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;

type SftpError = Error & { code?: number | string };

function classifyType(mode: number): SftpEntryType {
  if (mode & 0o40000) return 'directory';
  if (mode & 0o120000) return 'symlink';
  if (mode & 0o100000) return 'file';
  return 'other';
}

function joinRemotePath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/+$/, '')}/${name}`;
}

function toSftpStat(attrs: Stats): SftpStat {
  return {
    type: classifyType(attrs.mode ?? 0),
    size: attrs.size,
    mtime: (attrs.mtime ?? 0) * 1000,
    mode: attrs.mode ?? 0,
  };
}

function wrapSftp<T>(
  remotePath: string,
  action: string,
  fn: (cb: (err: Error | undefined, result: T) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((err, result) => {
      if (err) {
        reject(formatSftpError(err, remotePath, action));
      } else {
        resolve(result);
      }
    });
  });
}

function isMissingPathError(err: Error): boolean {
  const sftpError = err as SftpError;
  const code = typeof sftpError.code === 'number' ? sftpError.code : undefined;
  return (
    code === 2 ||
    err.message.toLowerCase().includes('no such file') ||
    err.message.includes('远程路径不存在')
  );
}

function formatSftpError(err: Error, remotePath: string, action: string): Error {
  const sftpError = err as SftpError;
  const code = typeof sftpError.code === 'number' ? sftpError.code : undefined;
  const message = err.message.toLowerCase();

  if (code === 2 || message.includes('no such file')) {
    return new Error(`远程路径不存在：${remotePath}`);
  }
  if (code === 3 || message.includes('permission denied')) {
    return new Error(`没有权限${action}远程路径：${remotePath}`);
  }
  if (code === 4 || message.includes('failure')) {
    return new Error(`远程文件系统${action}失败：${remotePath}`);
  }

  return new Error(`远程文件系统${action}失败：${remotePath}（${err.message}）`);
}

async function getSftp(hostId: string): Promise<SFTPWrapper> {
  const client = sshConnectionPool.get(hostId);
  if (!client?.isConnected) {
    throw new Error(`SSH 主机未连接：${hostId}`);
  }
  return client.sftp();
}

export async function readDir(hostId: string, remotePath: string): Promise<SftpEntry[]> {
  const sftp = await getSftp(hostId);

  let entries: { filename: string; longname: string; attrs: Stats }[];
  try {
    entries = await wrapSftp<{ filename: string; longname: string; attrs: Stats }[]>(
      remotePath,
      '读取',
      (cb) => sftp.readdir(remotePath, cb)
    );
  } catch (err) {
    if (isMissingPathError(err as Error)) return [];
    throw err;
  }

  const results: SftpEntry[] = entries
    .filter((e) => e.filename !== '.' && e.filename !== '..' && !e.filename.includes('/'))
    .map((e) => ({
      name: e.filename,
      path: joinRemotePath(remotePath, e.filename),
      type: classifyType(e.attrs.mode ?? 0),
      size: e.attrs.size,
      mtime: (e.attrs.mtime ?? 0) * 1000,
      mode: e.attrs.mode ?? 0,
    }));

  results.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

export async function stat(hostId: string, remotePath: string): Promise<SftpStat> {
  const sftp = await getSftp(hostId);
  const attrs = await wrapSftp<Stats>(remotePath, '读取', (cb) => sftp.stat(remotePath, cb));
  return toSftpStat(attrs);
}

export async function readFile(hostId: string, remotePath: string): Promise<string> {
  const sftp = await getSftp(hostId);
  const attrs = await wrapSftp<Stats>(remotePath, '读取', (cb) => sftp.stat(remotePath, cb));
  const fileType = classifyType(attrs.mode ?? 0);

  if (fileType !== 'file') {
    throw new Error(`远程路径不是普通文件：${remotePath}`);
  }
  if (attrs.size > MAX_READ_FILE_BYTES) {
    throw new Error(`远程文件过大，无法读取（${attrs.size} 字节）`);
  }

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createReadStream(remotePath, { end: Math.max(0, attrs.size - 1) });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return Buffer.concat(chunks).toString('utf8');
}
