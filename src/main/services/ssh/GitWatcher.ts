import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AsyncSubscription, Event } from '@parcel/watcher';
import { subscribe } from '@parcel/watcher';
import * as RemoteSync from './RemoteSync';

interface PendingChange {
  type: 'upload' | 'delete';
  localPath: string;
}

interface WatchedProject {
  hostId: string;
  localPath: string;
  remotePath: string;
  subscription: AsyncSubscription;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<string, PendingChange>;
  // Periodic reconcile heartbeat — catches anything the watcher might drop.
  reconcileTimer: ReturnType<typeof setInterval> | null;
}

const watchedProjects = new Map<string, WatchedProject>();
const DEBOUNCE_MS = 600;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 min safety net

// Directories whose contents we never sync. Files at these paths under any depth are skipped.
const SKIP_DIR_SEGMENTS = ['node_modules', '.git', '.enso-cache'];
// File-name patterns that are typically transient and should not be uploaded.
const SKIP_FILE_PATTERNS = [/\.swp$/i, /^\.#/, /^~\$/, /\.tmp$/i, /\.crdownload$/i];

function normalizeRel(localRoot: string, fullPath: string): string {
  return path.relative(localRoot, fullPath).replace(/\\/g, '/');
}

function shouldSkipPath(rel: string): boolean {
  if (!rel) return true;
  if (rel === '.enso-remote.json') return true;
  const segments = rel.split('/');
  for (const seg of segments) {
    if (SKIP_DIR_SEGMENTS.includes(seg)) return true;
  }
  const fileName = segments[segments.length - 1] ?? '';
  if (SKIP_FILE_PATTERNS.some((re) => re.test(fileName))) return true;
  return false;
}

function toRemotePath(entry: WatchedProject, rel: string): string {
  const base = entry.remotePath.replace(/\/+$/, '');
  return `${base}/${rel}`;
}

export async function startGitWatch(
  hostId: string,
  localPath: string,
  remotePath: string
): Promise<void> {
  const key = path.resolve(localPath);
  if (watchedProjects.has(key)) return;
  if (!fs.existsSync(localPath)) return;

  const entry: WatchedProject = {
    hostId,
    localPath: key,
    remotePath,
    subscription: null as unknown as AsyncSubscription,
    debounceTimer: null,
    pending: new Map(),
    reconcileTimer: null,
  };

  // Run a startup reconcile so anything edited while the app was offline (or
  // events dropped by the OS watcher) is caught immediately. Fire-and-forget;
  // failure here is non-fatal — the watcher still works.
  RemoteSync.reconcile(hostId, key, remotePath).catch((err: unknown) => {
    console.warn('[GitWatcher] startup reconcile failed:', (err as Error).message);
  });

  const subscription = await subscribe(
    key,
    (_err: Error | null, events: Event[]) => {
      if (_err) {
        console.warn('[GitWatcher] watcher error:', _err.message);
        return;
      }

      for (const event of events) {
        const rel = normalizeRel(key, event.path);
        if (shouldSkipPath(rel)) continue;

        if (event.type === 'create' || event.type === 'update') {
          // Verify it's a regular file (and that it still exists — events can race).
          let stats: fs.Stats;
          try {
            stats = fs.statSync(event.path);
          } catch {
            // If it disappeared, treat as a delete instead.
            entry.pending.set(rel, { type: 'delete', localPath: event.path });
            continue;
          }
          if (stats.isDirectory()) {
            // Directory creates need no explicit handling — child file events will
            // arrive, and uploadFile creates parent dirs on demand. Skip.
            continue;
          }
          if (!stats.isFile()) continue;
          entry.pending.set(rel, { type: 'upload', localPath: event.path });
        } else if (event.type === 'delete') {
          // Could be a file OR a directory; we cannot stat anymore. Enqueue delete
          // and let the SFTP layer figure it out (it handles both unlink and rmdir).
          entry.pending.set(rel, { type: 'delete', localPath: event.path });
        }
      }

      // Debounce: batch a burst of edits into one queue flush.
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        flushPending(entry);
        entry.debounceTimer = null;
      }, DEBOUNCE_MS);
    },
    {
      backend: process.platform === 'win32' ? 'windows' : undefined,
    }
  );

  entry.subscription = subscription;

  // Heartbeat reconcile every 5 min as a defence-in-depth — catches whatever the
  // OS watcher misses (rare on Windows, even rarer on macOS, but real).
  entry.reconcileTimer = setInterval(() => {
    RemoteSync.reconcile(hostId, key, remotePath).catch(() => {
      // best-effort
    });
  }, RECONCILE_INTERVAL_MS);
  if (typeof (entry.reconcileTimer as unknown as { unref?: () => void }).unref === 'function') {
    (entry.reconcileTimer as unknown as { unref: () => void }).unref();
  }

  watchedProjects.set(key, entry);
}

function flushPending(entry: WatchedProject): void {
  const changes = Array.from(entry.pending.values());
  entry.pending.clear();

  for (const change of changes) {
    const rel = normalizeRel(entry.localPath, change.localPath);
    if (!rel) continue;
    const remoteFilePath = toRemotePath(entry, rel);

    if (change.type === 'upload') {
      // Re-check existence at flush time (the file may have been deleted again).
      if (!fs.existsSync(change.localPath)) {
        RemoteSync.enqueueDelete(entry.hostId, remoteFilePath);
        continue;
      }
      RemoteSync.enqueueUpload(entry.hostId, change.localPath, remoteFilePath);
    } else {
      // For delete events: only enqueue if the file is actually gone locally.
      // (Some editors do atomic writes that look like delete+create back to back.)
      if (fs.existsSync(change.localPath)) {
        RemoteSync.enqueueUpload(entry.hostId, change.localPath, remoteFilePath);
      } else {
        RemoteSync.enqueueDelete(entry.hostId, remoteFilePath);
      }
    }
  }
}

/**
 * Force an immediate reconcile + flush for one watched project (or all, when
 * localPath is omitted). Used by agent Stop hooks to guarantee changes hit the
 * remote before the user sees "completed".
 */
export async function flushWatch(localPath?: string): Promise<void> {
  const targets = localPath
    ? [watchedProjects.get(path.resolve(localPath))].filter((x): x is WatchedProject => Boolean(x))
    : Array.from(watchedProjects.values());

  for (const entry of targets) {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    flushPending(entry);
    try {
      await RemoteSync.reconcile(entry.hostId, entry.localPath, entry.remotePath);
    } catch (err) {
      console.warn('[GitWatcher] flushWatch reconcile failed:', (err as Error).message);
    }
  }
}

export async function stopGitWatch(localPath: string): Promise<void> {
  const key = path.resolve(localPath);
  const entry = watchedProjects.get(key);
  if (!entry) return;

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
  flushPending(entry);
  await entry.subscription.unsubscribe().catch(() => {});
  watchedProjects.delete(key);
}

export async function stopAllGitWatches(): Promise<void> {
  const promises = Array.from(watchedProjects.values()).map(async (entry) => {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
    flushPending(entry);
    await entry.subscription.unsubscribe().catch(() => {});
  });
  await Promise.all(promises);
  watchedProjects.clear();
}

export function stopAllGitWatchesSync(): void {
  for (const entry of watchedProjects.values()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
    flushPending(entry);
    entry.subscription.unsubscribe().catch(() => {});
  }
  watchedProjects.clear();
}

export function listWatchedProjects(): Array<{
  hostId: string;
  localPath: string;
  remotePath: string;
}> {
  return Array.from(watchedProjects.values()).map((entry) => ({
    hostId: entry.hostId,
    localPath: entry.localPath,
    remotePath: entry.remotePath,
  }));
}
