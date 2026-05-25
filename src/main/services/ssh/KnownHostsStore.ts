import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

interface KnownHostEntry {
  hostname: string;
  port: number;
  keyType: string;
  fingerprint: string;
  rawLine: string;
}

export interface HostKeyVerifyResult {
  known: boolean;
  matched: boolean;
  entry?: KnownHostEntry;
}

export class KnownHostsStore {
  private filePath: string;
  private entries: KnownHostEntry[] = [];
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(app.getPath('userData'), 'ssh-known-hosts');
  }

  private load(): void {
    if (this.loaded) return;

    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      this.entries = this.parseFile(content);
    } catch {
      // File doesn't exist yet — start empty
      this.entries = [];
    }
    this.loaded = true;
  }

  private persist(): void {
    const lines = this.entries.map((e) => e.rawLine);
    const content = `${lines.join('\n')}\n`;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write via temp file + rename
    const tmpFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpFile, content, 'utf8');
    fs.renameSync(tmpFile, this.filePath);
  }

  verify(
    hostname: string,
    port: number,
    keyType: string,
    fingerprint: string
  ): HostKeyVerifyResult {
    this.load();

    const key = this.entryKey(hostname, port);
    const matching = this.entries.filter((e) => this.entryKey(e.hostname, e.port) === key);

    if (matching.length === 0) {
      return { known: false, matched: false };
    }

    const byType = matching.filter((e) => e.keyType === keyType);
    if (byType.length === 0) {
      // Known host but different key type — treat as mismatch
      return { known: true, matched: false, entry: matching[0] };
    }

    const matched = byType.some((e) => e.fingerprint === fingerprint);
    return {
      known: true,
      matched,
      entry: matched ? byType[0] : byType[0],
    };
  }

  add(hostname: string, port: number, keyType: string, fingerprint: string): void {
    this.load();

    const rawLine = this.formatLine(hostname, port, keyType, fingerprint);
    const entry: KnownHostEntry = { hostname, port, keyType, fingerprint, rawLine };

    // Replace existing entry for same host+port+keyType
    const key = this.entryKey(hostname, port);
    const idx = this.entries.findIndex(
      (e) => this.entryKey(e.hostname, e.port) === key && e.keyType === keyType
    );
    if (idx !== -1) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }

    this.persist();
  }

  remove(hostname: string, port: number): void {
    this.load();

    const key = this.entryKey(hostname, port);
    this.entries = this.entries.filter((e) => this.entryKey(e.hostname, e.port) !== key);
    this.persist();
  }

  private entryKey(hostname: string, port: number): string {
    return port === 22 ? hostname : `[${hostname}]:${port}`;
  }

  private formatLine(hostname: string, port: number, keyType: string, fingerprint: string): string {
    const hostPart = this.entryKey(hostname, port);
    // OpenSSH known_hosts format: hostname keytype SHA256:fingerprint
    return `${hostPart} ${keyType} ${fingerprint}`;
  }

  private parseFile(content: string): KnownHostEntry[] {
    const entries: KnownHostEntry[] = [];

    for (const rawLine of content.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;

      const [hostPart, keyType, fingerprint] = parts;
      const { hostname, port } = this.parseHostPart(hostPart);

      entries.push({ hostname, port, keyType, fingerprint, rawLine: trimmed });
    }

    return entries;
  }

  private parseHostPart(hostPart: string): { hostname: string; port: number } {
    // [hostname]:port format for non-standard ports
    const bracketMatch = hostPart.match(/^\[(.+)\]:(\d+)$/);
    if (bracketMatch) {
      return { hostname: bracketMatch[1], port: Number.parseInt(bracketMatch[2], 10) };
    }
    // Standard format: hostname (port 22)
    return { hostname: hostPart, port: 22 };
  }
}

// Lazy-initialized singleton — KnownHostsStore() touches app.getPath('userData')
// which is only valid after app.whenReady(). Defer construction until first access.
let _instance: KnownHostsStore | null = null;
function getKnownHostsStore(): KnownHostsStore {
  _instance ??= new KnownHostsStore();
  return _instance;
}

export const knownHostsStore = {
  verify(
    hostname: string,
    port: number,
    keyType: string,
    fingerprint: string
  ): HostKeyVerifyResult {
    return getKnownHostsStore().verify(hostname, port, keyType, fingerprint);
  },

  add(hostname: string, port: number, keyType: string, fingerprint: string): void {
    getKnownHostsStore().add(hostname, port, keyType, fingerprint);
  },

  remove(hostname: string, port: number): void {
    getKnownHostsStore().remove(hostname, port);
  },
};
