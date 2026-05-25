// Migration tests for the settings store. Focused on the SSH remote development
// fields added in T-003 — confirms that old persisted state (which never had these
// fields) is backfilled with safe defaults and never crashes the merge.

import type { RemoteHost } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { migrateSettings } from '../migration';
import type { SettingsState } from '../types';

// Build a minimal `currentState` mock — we only need the fields the migrate path
// touches for SSH defaults and the deep-merged nested objects it references.
function buildCurrentState(): SettingsState {
  return {
    remoteHosts: [],
    remoteCacheRoot: undefined,
    largeFileThresholdBytes: 5 * 1024 * 1024,
    remoteMirrorMaxBytes: 500 * 1024 * 1024,
    // Nested objects the migrator deep-merges — must exist so spread doesn't crash.
    mainTabKeybindings: {},
    sourceControlKeybindings: {},
    searchKeybindings: {},
    editorKeybindings: {},
    globalKeybindings: {},
    workspaceKeybindings: {},
    editorSettings: {},
    claudeCodeIntegration: { statusLineFields: {} },
    commitMessageGenerator: {},
    codeReview: {},
    branchNameGenerator: {},
    todoPolish: {},
    hapiSettings: {},
    proxySettings: {},
    quickTerminal: {},
    agentDetectionStatus: {},
    agentSettings: {},
    mcpServers: [],
    promptPresets: [],
    xtermKeybindings: {},
    // Background fields used by sanitizers
    backgroundOpacity: 0.85,
    backgroundBlur: 0,
    backgroundBrightness: 1,
    backgroundSaturation: 1,
    backgroundImageEnabled: false,
    backgroundImagePath: '',
    backgroundUrlPath: '',
    backgroundFolderPath: '',
    backgroundSourceType: 'file',
    backgroundRandomEnabled: false,
    backgroundRandomInterval: 300,
    backgroundSizeMode: 'cover',
  } as unknown as SettingsState;
}

describe('migrateSettings — SSH remote development fields', () => {
  it('backfills remoteHosts to empty array when persisted state lacks the field', () => {
    const current = buildCurrentState();
    const result = migrateSettings({} as Partial<SettingsState>, current);

    expect(result.remoteHosts).toEqual([]);
    expect(result.largeFileThresholdBytes).toBe(5 * 1024 * 1024);
    expect(result.remoteMirrorMaxBytes).toBe(500 * 1024 * 1024);
  });

  it('coerces non-array remoteHosts to the default empty array', () => {
    const current = buildCurrentState();
    const corrupted = {
      remoteHosts: 'not-an-array' as unknown,
    } as Partial<SettingsState>;
    const result = migrateSettings(corrupted, current);
    expect(result.remoteHosts).toEqual([]);
  });

  it('preserves valid remoteHosts from persisted state', () => {
    const current = buildCurrentState();
    const persistedHost: RemoteHost = {
      id: 'host-1',
      alias: 'prod-server',
      host: '10.0.0.1',
      port: 22,
      user: 'ubuntu',
      authType: 'privateKey',
      privateKeyPath: '/home/me/.ssh/id_rsa',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };
    const result = migrateSettings(
      { remoteHosts: [persistedHost] } as Partial<SettingsState>,
      current
    );
    expect(result.remoteHosts).toHaveLength(1);
    expect(result.remoteHosts[0].alias).toBe('prod-server');
  });

  it('clamps largeFileThresholdBytes below floor to default', () => {
    const current = buildCurrentState();
    const result = migrateSettings(
      { largeFileThresholdBytes: 0 } as Partial<SettingsState>,
      current
    );
    // 0 is below the 1024-byte floor, so clampNumber raises it.
    expect(result.largeFileThresholdBytes).toBe(1024);
  });

  it('returns currentState unchanged when persistedState is undefined', () => {
    const current = buildCurrentState();
    const result = migrateSettings(undefined, current);
    expect(result).toBe(current);
  });
});
