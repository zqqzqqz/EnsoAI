import { stopAllCodeReviews } from '../services/ai';
import { disposeClaudeIdeBridge } from '../services/claude/ClaudeIdeBridge';
import { autoUpdaterService } from '../services/updater/AutoUpdater';
import { webInspectorServer } from '../services/webInspector';
import { cleanupExecInPtys, cleanupExecInPtysSync } from '../utils/shell';
import { registerAgentHandlers } from './agent';
import { registerAppHandlers } from './app';
import {
  registerClaudeCompletionsHandlers,
  stopClaudeCompletionsWatchers,
} from './claudeCompletions';
import { registerClaudeConfigHandlers } from './claudeConfig';
import { registerClaudeProviderHandlers } from './claudeProvider';
import { registerCliHandlers } from './cli';
import { registerDialogHandlers } from './dialog';
import {
  cleanupTempFiles,
  cleanupTempFilesSync,
  registerFileHandlers,
  stopAllFileWatchers,
  stopAllFileWatchersSync,
} from './files';
import { clearAllGitServices, registerGitHandlers } from './git';
import { autoStartHapi, cleanupHapi, cleanupHapiSync, registerHapiHandlers } from './hapi';
import {
  autoStartRemoteShare,
  cleanupRemoteShare,
  registerRemoteShareHandlers,
} from './remoteShare';

export { autoStartHapi };
export { autoStartRemoteShare };

import { registerLogHandlers } from './log';
import { registerNotificationHandlers } from './notification';
import { registerSearchHandlers } from './search';
import { registerSettingsHandlers } from './settings';
import { registerShellHandlers } from './shell';
import { cleanupSsh, cleanupSshSync, registerSshHandlers } from './ssh';
import { destroyAllSshPtys, registerSshTerminalHandlers } from './sshTerminal';
import { registerTempWorkspaceHandlers } from './tempWorkspace';
import {
  destroyAllTerminals,
  destroyAllTerminalsAndWait,
  registerTerminalHandlers,
} from './terminal';
import { cleanupTmuxSync, registerTmuxHandlers } from './tmux';
import { cleanupTodo, cleanupTodoSync, registerTodoHandlers } from './todo';
import { registerUpdaterHandlers } from './updater';
import { registerWebInspectorHandlers } from './webInspector';
import { clearAllWorktreeServices, registerWorktreeHandlers } from './worktree';

export function registerIpcHandlers(): void {
  registerGitHandlers();
  registerWorktreeHandlers();
  registerFileHandlers();
  registerTerminalHandlers();
  registerAgentHandlers();
  registerDialogHandlers();
  registerAppHandlers();
  registerCliHandlers();
  registerShellHandlers();
  registerSettingsHandlers();
  registerLogHandlers();
  registerNotificationHandlers();
  registerUpdaterHandlers();
  registerSearchHandlers();
  registerHapiHandlers();
  registerRemoteShareHandlers();
  registerClaudeProviderHandlers();
  registerClaudeConfigHandlers();
  registerClaudeCompletionsHandlers();
  registerWebInspectorHandlers();
  registerTempWorkspaceHandlers();
  registerTmuxHandlers();
  registerTodoHandlers();
  registerSshHandlers();
  registerSshTerminalHandlers();
}

export async function cleanupAllResources(): Promise<void> {
  // Single global deadline well within FORCE_EXIT_TIMEOUT_MS (8000ms).
  // Previous approach ran steps serially with per-step 3000ms timeouts, which
  // could stack up to ~15s total — triggering the force-exit while async cleanup
  // was still running and causing double-cleanup of node-pty native resources.
  const TOTAL_ASYNC_TIMEOUT = 5500;
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, TOTAL_ASYNC_TIMEOUT));

  const safeRun = async (fn: () => Promise<void>, label: string): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[cleanup] ${label} warning:`, err);
    }
  };

  // Run all independent async cleanup steps in parallel, bounded by a single deadline.
  await Promise.race([
    Promise.allSettled([
      // node-pty PTYs used by short-lived commands (exec-in-pty pool)
      safeRun(() => cleanupExecInPtys(4000), 'execInPty'),
      // Hapi server + runner + cloudflared
      safeRun(() => cleanupHapi(4000), 'hapi'),
      // Remote share + bore
      safeRun(() => cleanupRemoteShare(), 'remoteShare'),
      // Interactive terminal PTY sessions
      safeRun(async () => {
        try {
          await destroyAllTerminalsAndWait();
        } catch (err) {
          console.warn('[cleanup] terminals warning:', err);
          // Fallback: force-kill without waiting
          destroyAllTerminals();
        }
      }, 'terminals'),
      // File system watchers
      safeRun(() => stopAllFileWatchers(), 'fileWatchers'),
      // Claude completions file watcher
      safeRun(() => stopClaudeCompletionsWatchers(), 'claudeCompletions'),
      // Temp files
      safeRun(() => cleanupTempFiles(), 'tempFiles'),
      // SSH connection pool (will be implemented in T-027)
      safeRun(() => cleanupSsh(), 'ssh'),
      // SSH PTY sessions
      destroyAllSshPtys(),
    ]),
    deadline,
  ]);

  // Fast synchronous cleanup (runs after async steps or deadline)
  try {
    cleanupTmuxSync();
  } catch (err) {
    console.warn('[cleanup] tmux warning:', err);
  }
  webInspectorServer.stop();
  stopAllCodeReviews();
  clearAllGitServices();
  clearAllWorktreeServices();
  autoUpdaterService.cleanup();
  disposeClaudeIdeBridge();
  await cleanupTodo();
}

/**
 * Synchronous cleanup for signal handlers (SIGINT/SIGTERM).
 * Kills child processes immediately without waiting for graceful shutdown.
 * This ensures clean exit when electron-vite terminates quickly.
 */
export function cleanupAllResourcesSync(): void {
  console.log('[app] Sync cleanup starting...');

  // Kill any in-flight execInPty commands first (sync)
  cleanupExecInPtysSync();

  // Kill Hapi/Cloudflared processes (sync)
  cleanupHapiSync();

  // Kill Remote Share/Bore processes (sync via cleanup)
  try {
    cleanupRemoteShare();
  } catch {
    /* ignore */
  }

  // Kill tmux enso server (sync)
  cleanupTmuxSync();

  // Stop Web Inspector server (sync)
  webInspectorServer.stop();

  // Kill all PTY sessions immediately (sync)
  destroyAllTerminals();

  // Stop all code review processes (sync)
  stopAllCodeReviews();

  // Stop file watchers (sync)
  stopAllFileWatchersSync();

  // Clear service caches (sync)
  clearAllGitServices();
  clearAllWorktreeServices();

  autoUpdaterService.cleanup();

  // Dispose Claude IDE Bridge (sync)
  disposeClaudeIdeBridge();

  // Close Todo database (sync — just nulls the reference, no async callback)
  cleanupTodoSync();

  // Clean up temp files (sync)
  cleanupTempFilesSync();

  // SSH connection pool (will be wired in T-027)
  cleanupSshSync();

  // SSH PTY sessions
  destroyAllSshPtys();

  console.log('[app] Sync cleanup done');
}
