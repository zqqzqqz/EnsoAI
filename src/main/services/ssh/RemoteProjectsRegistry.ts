import * as path from 'node:path';
import type { RemoteProject } from '@shared/types';
import { readSettings, writeSettingsImmediate } from '../../ipc/settings';

const SETTINGS_KEY = 'enso-settings';

interface PersistedSettingsState {
  state?: {
    remoteProjects?: RemoteProject[];
    [key: string]: unknown;
  };
  version?: number;
}

function getSettingsState(settings: Record<string, unknown> | null): PersistedSettingsState {
  const persisted = settings?.[SETTINGS_KEY];
  return persisted && typeof persisted === 'object' ? (persisted as PersistedSettingsState) : {};
}

// In-memory cache synced to settings.json
const projects = new Map<string, RemoteProject>();

function normalizeLocalPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

function loadFromSettings(): void {
  if (projects.size > 0) return; // Already loaded
  const settingsState = getSettingsState(readSettings());
  const list = Array.isArray(settingsState.state?.remoteProjects)
    ? settingsState.state.remoteProjects
    : [];
  for (const p of list) {
    projects.set(p.id, { ...p, localPath: normalizeLocalPath(p.localPath) });
  }
}

function persist(): void {
  const settings = readSettings() ?? {};
  const persisted = getSettingsState(settings);
  const next = {
    ...settings,
    [SETTINGS_KEY]: {
      ...persisted,
      state: {
        ...persisted.state,
        remoteProjects: Array.from(projects.values()),
      },
    },
  };
  writeSettingsImmediate(next);
}

export function registerRemoteProject(project: RemoteProject): void {
  loadFromSettings();
  projects.set(project.id, {
    ...project,
    localPath: normalizeLocalPath(project.localPath),
  });
  persist();
}

export function unregisterRemoteProject(id: string): void {
  loadFromSettings();
  projects.delete(id);
  persist();
}

export function listRemoteProjects(): RemoteProject[] {
  loadFromSettings();
  return Array.from(projects.values());
}

export function resolveRemoteFile(filePath: string):
  | {
      project: RemoteProject;
      remotePath: string;
    }
  | undefined {
  loadFromSettings();
  const normalizedFilePath = normalizeLocalPath(filePath);
  const project = Array.from(projects.values())
    .filter(
      (candidate) =>
        normalizedFilePath === candidate.localPath ||
        normalizedFilePath.startsWith(`${candidate.localPath}/`)
    )
    .sort((a, b) => b.localPath.length - a.localPath.length)[0];

  if (!project) return undefined;

  const relativePath = path.relative(project.localPath, normalizedFilePath).replace(/\\/g, '/');
  const remoteBase = project.remotePath.replace(/\/+$/, '');
  return { project, remotePath: relativePath ? `${remoteBase}/${relativePath}` : remoteBase };
}
