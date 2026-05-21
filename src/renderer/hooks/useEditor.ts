import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { isUnsupportedBinaryFile } from '@/components/files/fileIcons';
import { useEditorStore } from '@/stores/editor';
import { useRemoteProjectsStore } from '@/stores/remoteProjects';
import { useSettingsStore } from '@/stores/settings';

const PARTIAL_LINE_COUNT = 1000;

export interface LargeFileState {
  path: string;
  size: number;
}

export function useEditor() {
  const {
    tabs,
    activeTabPath,
    pendingCursor,
    openFile,
    closeFile,
    closeOtherFiles,
    closeFilesToLeft,
    closeFilesToRight,
    closeAllFiles,
    setActiveFile,
    updateFileContent,
    markFileSaved,
    setTabViewState,
    reorderTabs,
    setPendingCursor,
  } = useEditorStore();

  const queryClient = useQueryClient();
  const [largeFileState, setLargeFileState] = useState<LargeFileState | null>(null);

  const isRemoteProjectFile = useCallback((filePath: string) => {
    return useRemoteProjectsStore.getState().projects.some((p) => filePath.startsWith(p.localPath));
  }, []);

  const checkFileSize = useCallback(
    async (filePath: string): Promise<{ ok: boolean; size?: number }> => {
      if (!isRemoteProjectFile(filePath)) return { ok: true };

      const threshold = useSettingsStore.getState().largeFileThresholdBytes;
      const stat = await window.electronAPI.file.stat(filePath);
      if (!stat) return { ok: true };
      if (stat.size > threshold) {
        return { ok: false, size: stat.size };
      }
      return { ok: true };
    },
    [isRemoteProjectFile]
  );

  // Background refresh: re-read file from disk and silently update store (only if tab is not dirty)
  const refreshFileContent = useCallback(
    async (path: string) => {
      const currentTabs = useEditorStore.getState().tabs;
      const tab = currentTabs.find((t) => t.path === path);
      if (!tab || tab.isDirty) return;

      try {
        const { content, isBinary } = await window.electronAPI.file.read(path);
        if (isBinary) return;
        // Re-check after async IO to avoid race conditions
        const latestTab = useEditorStore.getState().tabs.find((t) => t.path === path);
        if (latestTab && !latestTab.isDirty && latestTab.content !== content) {
          updateFileContent(path, content, false);
        }
      } catch {
        // File may have been deleted or become inaccessible
      }
    },
    [updateFileContent]
  );

  const loadFile = useMutation({
    mutationFn: async (path: string) => {
      const sizeCheck = await checkFileSize(path);
      if (!sizeCheck.ok) {
        setLargeFileState({ path, size: sizeCheck.size! });
        return { content: '', encoding: 'utf-8', isBinary: false, isLargeFile: true };
      }

      const { content, encoding, isBinary } = await window.electronAPI.file.read(path);
      openFile({
        path,
        content,
        encoding,
        isDirty: false,
        isUnsupported: isUnsupportedBinaryFile(path, isBinary),
      });
      return { content, encoding, isBinary };
    },
  });

  const saveFile = useMutation({
    mutationFn: async (path: string) => {
      // Get latest tabs from store to avoid stale closure issue
      const currentTabs = useEditorStore.getState().tabs;
      const file = currentTabs.find((f) => f.path === path);
      if (!file) throw new Error('File not found');
      await window.electronAPI.file.write(path, file.content, file.encoding);
      markFileSaved(path);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file', 'list'] });
    },
  });

  // Load file and navigate to specific line/column
  const navigateToFile = useCallback(
    async (
      path: string,
      line?: number,
      column?: number,
      matchLength?: number,
      previewMode?: 'off' | 'split' | 'fullscreen'
    ) => {
      const existingTab = tabs.find((t) => t.path === path);

      if (existingTab) {
        setActiveFile(path);
        // Background refresh to pick up external modifications
        refreshFileContent(path);
      } else {
        try {
          const sizeCheck = await checkFileSize(path);
          if (!sizeCheck.ok) {
            setLargeFileState({ path, size: sizeCheck.size! });
            return;
          }

          const { content, encoding, isBinary } = await window.electronAPI.file.read(path);
          openFile({
            path,
            content,
            encoding,
            isDirty: false,
            isUnsupported: isUnsupportedBinaryFile(path, isBinary),
          });
        } catch {
          return;
        }
      }

      // Set pending cursor position if line is specified
      if (line !== undefined) {
        setPendingCursor({ path, line, column, matchLength, previewMode });
      }
    },
    [tabs, setActiveFile, openFile, setPendingCursor, refreshFileContent, checkFileSize]
  );

  // Large file dialog: open anyway
  const confirmOpenLargeFile = useCallback(
    async (mode: 'full' | 'partial') => {
      const state = largeFileState;
      if (!state) return;
      setLargeFileState(null);

      const { content, encoding, isBinary } = await window.electronAPI.file.read(state.path);

      if (mode === 'partial') {
        const lines = content.split('\n');
        const truncated =
          lines.slice(0, PARTIAL_LINE_COUNT).join('\n') +
          `\n\n... (file too large, showing first ${PARTIAL_LINE_COUNT} lines)`;
        openFile({
          path: state.path,
          content: truncated,
          encoding,
          isDirty: false,
          isUnsupported: isUnsupportedBinaryFile(state.path, isBinary),
        });
      } else {
        openFile({
          path: state.path,
          content,
          encoding,
          isDirty: false,
          isUnsupported: isUnsupportedBinaryFile(state.path, isBinary),
        });
      }
    },
    [largeFileState, openFile]
  );

  const cancelOpenLargeFile = useCallback(() => {
    setLargeFileState(null);
  }, []);

  const activeTab = tabs.find((f) => f.path === activeTabPath) || null;

  return {
    tabs,
    activeTab,
    pendingCursor,
    loadFile,
    saveFile,
    closeFile,
    closeOtherFiles,
    closeFilesToLeft,
    closeFilesToRight,
    closeAllFiles,
    setActiveFile,
    updateFileContent,
    setTabViewState,
    reorderTabs,
    setPendingCursor,
    navigateToFile,
    refreshFileContent,
    largeFileState,
    confirmOpenLargeFile,
    cancelOpenLargeFile,
  };
}
