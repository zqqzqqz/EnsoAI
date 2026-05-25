import type { ClientChannel } from 'ssh2';
import type { SshClient } from './SshClient';

interface SshPtySession {
  id: string;
  hostId: string;
  channel: ClientChannel;
  onData: (data: string) => void;
  onExit: (exitCode: number | null) => void;
}

const sessions = new Map<string, SshPtySession>();
let counter = 0;

// Injected by IPC layer to avoid circular dependency
let _getClient: (hostId: string) => SshClient | undefined = () => undefined;

export function setSshPtyClientGetter(getter: (hostId: string) => SshClient | undefined): void {
  _getClient = getter;
}

export async function createSshPty(
  hostId: string,
  options: { cols?: number; rows?: number; cwd?: string },
  onData: (data: string) => void,
  onExit: (exitCode: number | null) => void
): Promise<string> {
  const client = _getClient(hostId);
  if (!client || !client.isConnected) {
    throw new Error(`SSH 主机未连接：${hostId}`);
  }

  const channel = await client.shell({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
  });

  const id = `ssh-pty-${++counter}`;
  const session: SshPtySession = { id, hostId, channel, onData, onExit };

  channel.on('data', (data: Buffer) => {
    onData(data.toString('utf8'));
  });

  channel.on('close', () => {
    sessions.delete(id);
    onExit(null);
  });

  // Navigate to cwd if specified
  if (options.cwd) {
    channel.write(`cd "${options.cwd}"\n`);
  }

  sessions.set(id, session);
  return id;
}

export function writeSshPty(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.channel.write(data);
}

export function resizeSshPty(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  session.channel.setWindow(rows, cols, 0, 0);
}

export function destroySshPty(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.channel.close();
  sessions.delete(id);
}

export function destroyAllSshPtys(): void {
  for (const session of sessions.values()) {
    try {
      session.channel.close();
    } catch {
      // Best-effort cleanup
    }
  }
  sessions.clear();
}
