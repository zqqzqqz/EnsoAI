import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  createSshPty,
  destroyAllSshPtys,
  destroySshPty,
  resizeSshPty,
  setSshPtyClientGetter,
  writeSshPty,
} from '../services/ssh/SshPty';
import { sshConnectionPool } from './ssh';

export function registerSshTerminalHandlers(): void {
  setSshPtyClientGetter((hostId) => sshConnectionPool.get(hostId));

  ipcMain.handle(
    IPC_CHANNELS.SSH_TERMINAL_CREATE,
    async (
      event,
      hostId: string,
      options: { cols?: number; rows?: number; cwd?: string } | undefined
    ): Promise<string> => {
      const opts = options ?? {};
      const id = await createSshPty(
        hostId,
        { cols: opts.cols, rows: opts.rows, cwd: opts.cwd },
        (data) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.SSH_TERMINAL_DATA, { id, data });
          }
        },
        (exitCode) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.SSH_TERMINAL_EXIT, { id, exitCode });
          }
        }
      );
      return id;
    }
  );

  ipcMain.handle(IPC_CHANNELS.SSH_TERMINAL_WRITE, async (_, id: string, data: string) => {
    writeSshPty(id, data);
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_TERMINAL_RESIZE,
    async (_, id: string, size: { cols: number; rows: number }) => {
      resizeSshPty(id, size.cols, size.rows);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SSH_TERMINAL_CLOSE, async (_, id: string) => {
    destroySshPty(id);
  });
}

export { destroyAllSshPtys };
