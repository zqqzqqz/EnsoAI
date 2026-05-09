import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, net } from 'electron';
import { killProcessTree } from '../../utils/processUtils';

const execFileAsync = promisify(execFile);

const boreBin = path.join(
  app.getPath('userData'),
  'bin',
  process.platform === 'win32' ? 'bore.exe' : 'bore'
);

export interface BoreStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  url?: string;
  error?: string;
}

export interface BoreConfig {
  port: number;
  server: string;
}

function getBorePlatformSuffix(): string {
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc.zip';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin.tar.gz' : 'x86_64-apple-darwin.tar.gz';
  }
  return 'x86_64-unknown-linux-musl.tar.gz';
}

async function getBoreDownloadUrl(): Promise<string> {
  const suffix = getBorePlatformSuffix();
  const response = await net.fetch('https://api.github.com/repos/ekzhang/bore/releases/latest');
  if (!response.ok) throw new Error(`GitHub API failed: ${response.status}`);
  const data = (await response.json()) as {
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  const asset = data.assets.find((a) => a.name.endsWith(suffix));
  if (!asset) throw new Error(`No bore release found for ${suffix}`);
  // Use GitHub mirror to bypass network restrictions
  return `https://ghfast.top/${asset.browser_download_url}`;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await net.fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
}

class BoreManager extends EventEmitter {
  private process: ReturnType<typeof spawn> | null = null;
  private status: BoreStatus = { installed: false, running: false };

  async checkInstalled(): Promise<{ installed: boolean; version?: string }> {
    if (!fs.existsSync(boreBin)) {
      return { installed: false };
    }

    try {
      const { stdout } = await execFileAsync(boreBin, ['--version']);
      const version = stdout.trim();
      this.status.installed = true;
      this.status.version = version;
      return { installed: true, version };
    } catch {
      return { installed: false };
    }
  }

  async install(): Promise<{ installed: boolean; version?: string; error?: string }> {
    try {
      const binDir = path.dirname(boreBin);
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }

      const url = await getBoreDownloadUrl();
      const archiveExt = process.platform === 'win32' ? '.zip' : '.tar.gz';
      const archivePath = path.join(binDir, `bore${archiveExt}`);

      console.log('[bore] Downloading from:', url);
      await downloadFile(url, archivePath);
      console.log('[bore] Download complete, extracting...');

      // Extract
      if (process.platform === 'win32') {
        const { execSync } = require('node:child_process');
        // Use PowerShell with escaped paths to avoid quote issues
        const psCmd = `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${binDir}' -Force`;
        execSync(`powershell -Command "${psCmd.replace(/"/g, '\\"')}"`, {
          timeout: 30000,
        });
        // zip may extract into a subdirectory, move bore.exe up
        const possibleSubdir = path.join(binDir, 'bore');
        if (fs.existsSync(path.join(possibleSubdir, 'bore.exe')) && !fs.existsSync(boreBin)) {
          fs.renameSync(path.join(possibleSubdir, 'bore.exe'), boreBin);
        }
      } else {
        const { execSync } = require('node:child_process');
        execSync(`tar -xzf '${archivePath}' -C '${binDir}'`, { timeout: 30000 });
        try {
          fs.chmodSync(boreBin, 0o755);
        } catch {
          /* ignore */
        }
      }

      // Clean up archive
      try {
        fs.unlinkSync(archivePath);
      } catch {
        /* ignore */
      }

      const result = await this.checkInstalled();
      if (!result.installed) {
        return { installed: false, error: 'Extraction completed but binary not found' };
      }
      this.emit('statusChanged', this.getStatus());
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[bore] Install failed:', errorMsg);
      return { installed: false, error: errorMsg };
    }
  }

  async start(config: BoreConfig): Promise<BoreStatus> {
    if (this.process) {
      return this.status;
    }

    const check = await this.checkInstalled();
    if (!check.installed) {
      this.status = { installed: false, running: false, error: 'Bore not installed' };
      this.emit('statusChanged', this.status);
      return this.status;
    }

    try {
      console.log(`[bore] Starting tunnel: local port ${config.port} -> ${config.server}`);

      this.process = spawn(boreBin, ['local', String(config.port), '--to', config.server], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let urlResolved = false;

      this.process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        console.log('[bore]', text.trim());

        // Parse public URL from bore output: "listening at bore.pub:XXXXX"
        const match = text.match(/listening at\s+(\S+)/i);
        if (match && !urlResolved) {
          urlResolved = true;
          const url = match[1];
          this.status = {
            installed: true,
            version: check.version,
            running: true,
            url,
          };
          this.emit('statusChanged', this.status);
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error('[bore]', data.toString().trim());
      });

      this.process.on('error', (error) => {
        console.error('[bore] Error:', error.message);
        this.status = {
          installed: true,
          version: check.version,
          running: false,
          error: error.message,
        };
        this.process = null;
        this.emit('statusChanged', this.status);
      });

      this.process.on('exit', (code) => {
        console.log('[bore] Exit code:', code);
        this.status = {
          installed: true,
          version: check.version,
          running: false,
          error: code !== null && code !== 0 ? `Process exited with code ${code}` : undefined,
        };
        this.process = null;
        this.emit('statusChanged', this.status);
      });

      this.status = {
        installed: true,
        version: check.version,
        running: true,
      };
      this.emit('statusChanged', this.status);

      return this.status;
    } catch (error) {
      this.status = {
        installed: true,
        version: check.version,
        running: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit('statusChanged', this.status);
      return this.status;
    }
  }

  async stop(): Promise<BoreStatus> {
    if (this.process) {
      try {
        killProcessTree(this.process);
      } catch {
        /* ignore */
      }
      this.process = null;
    }

    const check = await this.checkInstalled();
    this.status = {
      installed: check.installed,
      version: check.version,
      running: false,
    };
    this.emit('statusChanged', this.status);
    return this.status;
  }

  getStatus(): BoreStatus {
    return { ...this.status };
  }

  cleanup(): void {
    if (this.process) {
      try {
        killProcessTree(this.process);
      } catch {
        /* ignore */
      }
      this.process = null;
    }
  }
}

export const boreManager = new BoreManager();
