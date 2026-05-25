import type { HostKeyVerifyDecision, RemoteHostSaveInput, SftpStat } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import { credentialStore } from '../services/ssh/CredentialStore';
import {
  flushWatch,
  startGitWatch,
  stopAllGitWatches,
  stopAllGitWatchesSync,
} from '../services/ssh/GitWatcher';
import * as RemoteFs from '../services/ssh/RemoteFs';
import { RemoteHostStore } from '../services/ssh/RemoteHostStore';
import { listRemoteProjects, registerRemoteProject } from '../services/ssh/RemoteProjectsRegistry';
import * as RemoteSync from '../services/ssh/RemoteSync';
import {
  resolveVerifyKeyDecision,
  SshClient,
  SshClientError,
  setHostKeyVerifySender,
} from '../services/ssh/SshClient';
import { sshConnectionPool } from '../services/ssh/SshConnectionPool';
import * as SshPty from '../services/ssh/SshPty';

export { sshConnectionPool };

let remoteHostStore: RemoteHostStore;

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

export function registerSshHandlers(): void {
  remoteHostStore = new RemoteHostStore();

  // Wire pool to main window for IPC push events
  const win = getMainWindow();
  if (win) {
    sshConnectionPool.setSender(win.webContents);
    RemoteSync.setSyncSender(win.webContents);
    setHostKeyVerifySender(win.webContents);
  }

  // Host management
  ipcMain.handle(IPC_CHANNELS.SSH_HOST_LIST, async () => {
    return remoteHostStore.list();
  });

  ipcMain.handle(IPC_CHANNELS.SSH_HOST_SAVE, async (_, input: RemoteHostSaveInput) => {
    const host = await remoteHostStore.save(input);

    // Persist credentials if provided
    if (input.password || input.passphrase) {
      credentialStore.setCredential(host.id, {
        password: input.password,
        passphrase: input.passphrase,
      });
    }

    return host;
  });

  ipcMain.handle(IPC_CHANNELS.SSH_HOST_DELETE, async (_, hostId: string) => {
    await remoteHostStore.delete(hostId);
    credentialStore.deleteCredential(hostId);
    await sshConnectionPool.disconnect(hostId);
  });

  ipcMain.handle(IPC_CHANNELS.SSH_HOST_TEST, async (_, input: RemoteHostSaveInput) => {
    const client = new SshClient();
    try {
      const host: import('@shared/types').RemoteHost = {
        id: 'test',
        alias: '',
        host: input.host.host,
        port: input.host.port,
        user: input.host.user,
        authType: input.host.authType,
        privateKeyPath: input.host.privateKeyPath,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const creds: { password?: string; privateKey?: Buffer; passphrase?: string } = {};
      if (input.password) creds.password = input.password;
      if (input.passphrase) creds.passphrase = input.passphrase;

      await client.connect({ host, ...creds });
      const { stdout } = await client.exec('uname -a');
      await client.disconnect();

      return { ok: true, serverVersion: stdout.trim() };
    } catch (err) {
      const sshErr =
        err instanceof SshClientError
          ? err
          : new SshClientError((err as Error).message, 'UNKNOWN', err as Error);
      return {
        ok: false,
        errorCode: sshErr.code,
        errorMessage: sshErr.message,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SSH_HOST_CONNECT, async (_, hostId: string) => {
    const host = await remoteHostStore.getById(hostId);
    if (!host) throw new Error(`未找到 SSH 主机：${hostId}`);

    const creds: { password?: string; privateKey?: Buffer; passphrase?: string } = {};
    const stored = credentialStore.getCredential(hostId);
    if (stored?.password) creds.password = stored.password;
    if (stored?.passphrase) creds.passphrase = stored.passphrase;

    await sshConnectionPool.acquire(host, creds);

    // Re-start file watchers for all remote projects belonging to this host.
    // Each watcher runs its own startup reconcile, so changes made while
    // disconnected (or while the app was closed) are caught here.
    for (const project of listRemoteProjects().filter((p) => p.hostId === hostId)) {
      await startGitWatch(hostId, project.localPath, project.remotePath);
    }

    // Move failed uploads back to pending and kick the queue. Reconcile above
    // covers files we may have missed entirely; this covers files that failed
    // mid-flight before the disconnect.
    RemoteSync.retryPendingUploads(hostId);

    return sshConnectionPool.getStatus(hostId);
  });

  ipcMain.handle(IPC_CHANNELS.SSH_HOST_DISCONNECT, async (_, hostId: string) => {
    await sshConnectionPool.disconnect(hostId);
  });

  ipcMain.handle(IPC_CHANNELS.SSH_HOST_CREDENTIAL_META, async (_, hostId: string) => {
    const stored = credentialStore.getCredential(hostId);
    return {
      hostId,
      hasPassword: !!stored?.password,
      hasPassphrase: !!stored?.passphrase,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_HOST_VERIFY_KEY_RESPONSE,
    async (_, hostId: string, decision: HostKeyVerifyDecision) => {
      resolveVerifyKeyDecision(hostId, decision);
    }
  );

  // Filesystem (SFTP)
  ipcMain.handle(IPC_CHANNELS.SSH_FS_READ_DIR, async (_, hostId: string, path: string) => {
    return RemoteFs.readDir(hostId, path);
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_FS_STAT,
    async (_, hostId: string, path: string): Promise<SftpStat> => {
      return RemoteFs.stat(hostId, path);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SSH_FS_READ_FILE, async (_, hostId: string, path: string) => {
    return RemoteFs.readFile(hostId, path);
  });

  // Sync engine
  ipcMain.handle(IPC_CHANNELS.SSH_SYNC_ESTIMATE, async (_, hostId: string, remotePath: string) => {
    return RemoteSync.estimate(hostId, remotePath);
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_SYNC_MIRROR,
    async (_, hostId: string, remotePath: string, localPath: string) => {
      const result = await RemoteSync.mirror(hostId, remotePath, localPath);
      registerRemoteProject({
        id: `rp-${hostId}-${Date.now()}`,
        hostId,
        remotePath,
        localPath,
        alias: remotePath.split('/').filter(Boolean).pop() ?? remotePath,
        openedAt: Date.now(),
      });
      await startGitWatch(hostId, localPath, remotePath);
      return result;
    }
  );

  ipcMain.handle(IPC_CHANNELS.SSH_SYNC_CANCEL, async (_, jobId: string) => {
    RemoteSync.cancel(jobId);
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_SYNC_UPLOAD,
    async (_, hostId: string, localPath: string, remotePath: string) => {
      return RemoteSync.upload(hostId, localPath, remotePath);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SSH_SYNC_QUEUE_STATUS, async (_, hostId: string) => {
    return RemoteSync.getQueueStatus(hostId);
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_SYNC_START_WATCH,
    async (_, hostId: string, localPath: string, remotePath: string) => {
      await startGitWatch(hostId, localPath, remotePath);
    }
  );

  // Force a full local→remote reconcile (mtime/size diff). Safe to call repeatedly —
  // it only enqueues uploads for files that differ. `deleteExtraneous` (optional)
  // also enqueues deletes for remote files with no local counterpart.
  ipcMain.handle(
    IPC_CHANNELS.SSH_SYNC_RECONCILE,
    async (
      _,
      hostId: string,
      localPath: string,
      remotePath: string,
      options?: { deleteExtraneous?: boolean }
    ) => {
      return RemoteSync.reconcile(hostId, localPath, remotePath, options);
    }
  );

  // Move all failed tasks (after MAX_RETRIES) back to pending and kick the queue.
  ipcMain.handle(IPC_CHANNELS.SSH_SYNC_RETRY_FAILED, async (_, hostId: string) => {
    RemoteSync.retryPendingUploads(hostId);
  });

  // Flush all pending watcher events and run a reconcile across every watched
  // project. Used by agent Stop hooks to guarantee everything hits the wire.
  ipcMain.handle(IPC_CHANNELS.SSH_SYNC_FLUSH_WATCH, async (_, localPath?: string) => {
    await flushWatch(localPath);
  });

  // Terminal handlers are registered in registerSshTerminalHandlers()
  // (see src/main/ipc/sshTerminal.ts) — they read the same connection pool.

  // Start watchers for all persisted remote projects (uploads will queue until SSH connects)
  for (const project of listRemoteProjects()) {
    startGitWatch(project.hostId, project.localPath, project.remotePath).catch(() => {});
  }
}

export async function cleanupSsh(): Promise<void> {
  await RemoteSync.flushSyncQueue(3000);
  await stopAllGitWatches();
  SshPty.destroyAllSshPtys();
  await sshConnectionPool.disconnectAll();
}

export function cleanupSshSync(): void {
  stopAllGitWatchesSync();
  SshPty.destroyAllSshPtys();
  sshConnectionPool.destroyAll();
}
