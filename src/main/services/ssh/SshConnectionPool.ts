import type { RemoteHost, SshConnectionState, SshConnectionStatus } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import type { WebContents } from 'electron';
import { SshClient } from './SshClient';

export class SshConnectionPool {
  private clients = new Map<string, SshClient>();
  private pendingAcquires = new Map<string, Promise<SshClient>>();
  private sender: WebContents | null = null;

  setSender(sender: WebContents): void {
    this.sender = sender;
  }

  acquire(
    host: RemoteHost,
    credentials: { password?: string; privateKey?: Buffer; passphrase?: string }
  ): Promise<SshClient> {
    const existing = this.clients.get(host.id);
    if (existing?.isConnected) {
      return Promise.resolve(existing);
    }

    const pending = this.pendingAcquires.get(host.id);
    if (pending) {
      return pending;
    }

    if (existing) {
      existing.destroy();
      this.clients.delete(host.id);
    }

    const client = new SshClient();
    this.clients.set(host.id, client);

    client.on('statusChange', (status: SshConnectionStatus) => {
      this.broadcastState(host.id, status);
    });

    client.on('error', () => {
      if (this.clients.get(host.id) === client) {
        this.clients.delete(host.id);
      }
      this.broadcastState(host.id, 'error');
    });

    client.on('close', () => {
      if (this.clients.get(host.id) === client) {
        this.clients.delete(host.id);
      }
    });

    const acquire = client
      .connect({ host, ...credentials })
      .then(() => client)
      .catch((error) => {
        if (this.clients.get(host.id) === client) {
          this.clients.delete(host.id);
        }
        client.destroy();
        throw error;
      })
      .finally(() => {
        this.pendingAcquires.delete(host.id);
      });

    this.pendingAcquires.set(host.id, acquire);
    return acquire;
  }

  get(hostId: string): SshClient | undefined {
    return this.clients.get(hostId);
  }

  async disconnect(hostId: string): Promise<void> {
    const client = this.clients.get(hostId);
    if (!client) return;

    await client.disconnect();
    this.clients.delete(hostId);
    this.pendingAcquires.delete(hostId);
  }

  getStatus(hostId: string): SshConnectionState {
    const client = this.clients.get(hostId);
    if (!client) {
      return { hostId, status: 'disconnected' };
    }

    const state: SshConnectionState = {
      hostId,
      status: client.status,
    };

    if (client.status === 'connected') {
      state.connectedAt = Date.now();
    }

    return state;
  }

  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [_hostId, client] of this.clients) {
      promises.push(
        client.disconnect().catch(() => {
          client.destroy();
        })
      );
    }
    await Promise.all(promises);
    this.clients.clear();
    this.pendingAcquires.clear();
  }

  destroyAll(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
    this.pendingAcquires.clear();
  }

  private broadcastState(hostId: string, status: SshConnectionStatus): void {
    if (!this.sender || this.sender.isDestroyed()) return;

    const state: SshConnectionState = {
      hostId,
      status,
      connectedAt: status === 'connected' ? Date.now() : undefined,
    };

    this.sender.send(IPC_CHANNELS.SSH_HOST_STATUS, state);
  }
}

// Singleton — shared across IPC handlers
export const sshConnectionPool = new SshConnectionPool();
