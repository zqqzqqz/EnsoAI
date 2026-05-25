import type { RemoteHost, RemoteHostSaveInput } from '@shared/types';
import { readSettings, writeSettingsImmediate } from '../../ipc/settings';

const SETTINGS_KEY = 'enso-settings';

interface PersistedSettingsState {
  state?: {
    remoteHosts?: RemoteHost[];
    [key: string]: unknown;
  };
  version?: number;
}

function getSettingsState(settings: Record<string, unknown> | null): PersistedSettingsState {
  const persisted = settings?.[SETTINGS_KEY];
  return persisted && typeof persisted === 'object' ? (persisted as PersistedSettingsState) : {};
}

function readRemoteHosts(): RemoteHost[] {
  const settingsState = getSettingsState(readSettings());
  return Array.isArray(settingsState.state?.remoteHosts) ? settingsState.state.remoteHosts : [];
}

export class RemoteHostStore {
  async list(): Promise<RemoteHost[]> {
    return readRemoteHosts();
  }

  async save(input: RemoteHostSaveInput): Promise<RemoteHost> {
    const existing = await this.list();

    const now = Date.now();
    let host: RemoteHost;

    if (input.host.id) {
      const idx = existing.findIndex((h: RemoteHost) => h.id === input.host.id);
      if (idx === -1) {
        throw new Error(`未找到 SSH 主机：${input.host.id}`);
      }

      if (
        input.host.alias &&
        existing.some((h: RemoteHost) => h.alias === input.host.alias && h.id !== input.host.id)
      ) {
        throw new Error('主机别名已存在');
      }

      host = {
        ...existing[idx],
        ...input.host,
        id: input.host.id,
        updatedAt: now,
      };
      existing[idx] = host;
    } else {
      const alias = input.host.alias || input.host.host;
      if (existing.some((h: RemoteHost) => h.alias === alias)) {
        throw new Error('主机别名已存在');
      }

      host = {
        id: `ssh-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        alias,
        host: input.host.host,
        port: input.host.port,
        user: input.host.user,
        authType: input.host.authType,
        privateKeyPath: input.host.privateKeyPath,
        createdAt: now,
        updatedAt: now,
      };
      existing.push(host);
    }

    this.writeHosts(existing);
    return host;
  }

  async delete(hostId: string): Promise<void> {
    const existing = await this.list();
    const filtered = existing.filter((h: RemoteHost) => h.id !== hostId);
    if (filtered.length === existing.length) return;
    this.writeHosts(filtered);
  }

  async getById(hostId: string): Promise<RemoteHost | undefined> {
    const hosts = await this.list();
    return hosts.find((h: RemoteHost) => h.id === hostId);
  }

  private writeHosts(hosts: RemoteHost[]): void {
    const settings = readSettings() ?? {};
    const persisted = getSettingsState(settings);
    const next = {
      ...settings,
      [SETTINGS_KEY]: {
        ...persisted,
        state: {
          ...persisted.state,
          remoteHosts: hosts,
        },
      },
    };

    if (!writeSettingsImmediate(next)) {
      throw new Error('保存 SSH 主机失败');
    }
  }
}
