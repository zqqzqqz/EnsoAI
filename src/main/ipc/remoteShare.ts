import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { IPC_CHANNELS } from '@shared/types';
import { app, BrowserWindow, ipcMain } from 'electron';
import { boreManager } from '../services/remoteShare/BoreManager';
import { RemoteShareServer } from '../services/remoteShare/RemoteShareServer';
import { ptyManager } from './terminal';

export const remoteShareServer = new RemoteShareServer(ptyManager);

function generateToken(): string {
  return randomBytes(16).toString('hex');
}

interface StoredRemoteShareSettings {
  enabled: boolean;
  port: number;
  authToken: string;
  boreEnabled: boolean;
  boreServer: string;
}

export function registerRemoteShareHandlers(): void {
  // Remote Share Server handlers
  ipcMain.handle(IPC_CHANNELS.REMOTE_SHARE_START, async (_, config: { port: number; authToken: string }) => {
    const token = config.authToken || generateToken();
    const status = await remoteShareServer.start({ port: config.port, authToken: token });
    return { ...status, generatedToken: token };
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_SHARE_STOP, async () => {
    await boreManager.stop();
    return await remoteShareServer.stop();
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_SHARE_GET_STATUS, async () => {
    return remoteShareServer.getStatus();
  });

  remoteShareServer.on('statusChanged', (status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.REMOTE_SHARE_STATUS_CHANGED, status);
      }
    }
  });

  // Bore handlers
  ipcMain.handle(IPC_CHANNELS.BORE_CHECK, async () => {
    return await boreManager.checkInstalled();
  });

  ipcMain.handle(IPC_CHANNELS.BORE_INSTALL, async () => {
    return await boreManager.install();
  });

  ipcMain.handle(IPC_CHANNELS.BORE_START, async (_, config: { port: number; server: string }) => {
    return await boreManager.start(config);
  });

  ipcMain.handle(IPC_CHANNELS.BORE_STOP, async () => {
    return await boreManager.stop();
  });

  ipcMain.handle(IPC_CHANNELS.BORE_GET_STATUS, async () => {
    return boreManager.getStatus();
  });

  boreManager.on('statusChanged', (status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.BORE_STATUS_CHANGED, status);
      }
    }
  });
}

export async function cleanupRemoteShare(): Promise<void> {
  boreManager.cleanup();
  remoteShareServer.cleanup();
}

export async function autoStartRemoteShare(): Promise<void> {
  try {
    const settingsPath = join(app.getPath('userData'), 'settings.json');
    if (!existsSync(settingsPath)) return;

    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const settings = data?.['enso-settings']?.state?.remoteShareSettings as
      | StoredRemoteShareSettings
      | undefined;

    if (settings?.enabled) {
      console.log('[remote-share] Auto-starting from saved settings...');
      const token = settings.authToken || generateToken();
      const status = await remoteShareServer.start({
        port: settings.port || 3007,
        authToken: token,
      });

      if (status.running && settings.boreEnabled) {
        console.log('[bore] Auto-starting tunnel...');
        await boreManager.start({
          port: settings.port || 3007,
          server: settings.boreServer || 'bore.pub',
        });
      }
    }
  } catch (error) {
    console.error('[remote-share] Auto-start failed:', error);
  }
}
