import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, safeStorage } from 'electron';

interface CredentialEntry {
  password?: string;
  passphrase?: string;
}

type CredentialMap = Record<string, CredentialEntry>;

export class CredentialStore {
  private filePath: string;
  private credentials: CredentialMap = {};
  private loaded = false;
  private useMemoryFallback = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(app.getPath('userData'), 'ssh-credentials.enc');
  }

  private load(): void {
    if (this.loaded) return;

    if (!safeStorage.isEncryptionAvailable()) {
      this.useMemoryFallback = true;
      this.loaded = true;
      return;
    }

    try {
      const encrypted = fs.readFileSync(this.filePath);
      const json = safeStorage.decryptString(encrypted);
      this.credentials = JSON.parse(json) as CredentialMap;
    } catch {
      // File doesn't exist or is corrupted — start empty
      this.credentials = {};
    }

    this.loaded = true;
  }

  private persist(): void {
    if (this.useMemoryFallback) return;

    const json = JSON.stringify(this.credentials);
    const encrypted = safeStorage.encryptString(json);

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpFile, encrypted);
    fs.renameSync(tmpFile, this.filePath);
  }

  setCredential(hostId: string, entry: CredentialEntry): void {
    this.load();
    this.credentials[hostId] = entry;
    this.persist();
  }

  getCredential(hostId: string): CredentialEntry | undefined {
    this.load();
    return this.credentials[hostId];
  }

  deleteCredential(hostId: string): void {
    this.load();
    delete this.credentials[hostId];
    this.persist();
  }

  hasCredential(hostId: string): boolean {
    this.load();
    const entry = this.credentials[hostId];
    return !!(entry?.password || entry?.passphrase);
  }

  isMemoryFallback(): boolean {
    this.load();
    return this.useMemoryFallback;
  }
}

export const credentialStore = new CredentialStore();
