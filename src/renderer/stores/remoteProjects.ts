import type { RemoteProject } from '@shared/types';
import { create } from 'zustand';

interface SyncFailure {
  hostId: string;
  filePath: string;
  error: string;
  timestamp: number;
}

interface RemoteProjectsState {
  projects: RemoteProject[];
  syncFailures: SyncFailure[];

  addProject: (project: RemoteProject) => void;
  removeProject: (id: string) => void;
  getByHostId: (hostId: string) => RemoteProject[];
  addSyncFailure: (failure: SyncFailure) => void;
  clearSyncFailures: () => void;
}

export const useRemoteProjectsStore = create<RemoteProjectsState>((set, get) => ({
  projects: [],
  syncFailures: [],

  addProject: (project) => {
    set((s) => ({ projects: [...s.projects, project] }));
  },

  removeProject: (id) => {
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },

  getByHostId: (hostId) => {
    return get().projects.filter((p) => p.hostId === hostId);
  },

  addSyncFailure: (failure) => {
    set((s) => ({ syncFailures: [...s.syncFailures, failure] }));
  },

  clearSyncFailures: () => {
    set({ syncFailures: [] });
  },
}));
