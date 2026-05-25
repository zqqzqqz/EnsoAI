import type { RemoteHost, SftpEntry } from '@shared/types';
import { ChevronRight, Folder, FolderOpen, Loader2, Server } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface RemoteDirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: RemoteHost;
  onSelect: (host: RemoteHost, remotePath: string) => void;
}

// Cache: path → entries (to avoid re-fetching)
type DirCache = Map<string, SftpEntry[]>;

function RemoteDirNode({
  entry,
  depth,
  cache,
  setCache,
  selectedPath,
  onSelect,
  hostId,
}: {
  entry: SftpEntry;
  depth: number;
  cache: DirCache;
  setCache: React.Dispatch<React.SetStateAction<DirCache>>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  hostId: string;
}) {
  const isDir = entry.type === 'directory';
  const [expanded, setExpanded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  if (!isDir) return null;

  const isSelected = selectedPath === entry.path;

  const handleToggle = async () => {
    if (!expanded && !cache.has(entry.path)) {
      setLoading(true);
      setError('');
      try {
        const entries = await window.electronAPI.ssh.fs.readDir(hostId, entry.path);
        setCache((prev) => new Map(prev).set(entry.path, entries));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((prev) => !prev);
  };

  const children = cache.get(entry.path) ?? [];
  const dirChildren = children.filter((c) => c.type === 'directory');

  return (
    <div>
      <button
        type="button"
        className={cn(
          'flex h-7 w-full items-center gap-1 rounded-sm text-sm transition-colors hover:bg-accent/50',
          isSelected && 'bg-accent text-accent-foreground'
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(entry.path)}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
          onClick={(e) => {
            e.stopPropagation();
            handleToggle();
          }}
        />
        {expanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>

      {expanded && loading && (
        <div
          className="flex items-center gap-1 text-xs text-muted-foreground"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          正在加载...
        </div>
      )}

      {expanded && error && (
        <div
          className="text-xs text-destructive"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
        >
          {error}
        </div>
      )}

      {expanded &&
        !loading &&
        dirChildren.map((child) => (
          <RemoteDirNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            cache={cache}
            setCache={setCache}
            selectedPath={selectedPath}
            onSelect={onSelect}
            hostId={hostId}
          />
        ))}
    </div>
  );
}

export function RemoteDirectoryPicker({
  open,
  onOpenChange,
  host,
  onSelect,
}: RemoteDirectoryPickerProps) {
  const [connecting, setConnecting] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [rootEntries, setRootEntries] = React.useState<SftpEntry[]>([]);
  const [cache, setCache] = React.useState<DirCache>(new Map());
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [currentRootPath, setCurrentRootPath] = React.useState('');
  const [error, setError] = React.useState('');

  const initialPaths = React.useMemo(() => ['/'], []);

  React.useEffect(() => {
    if (!open) {
      setConnecting(false);
      setConnected(false);
      setRootEntries([]);
      setCache(new Map());
      setSelectedPath(null);
      setCurrentRootPath('');
      setError('');
      return;
    }

    let cancelled = false;
    const connectAndLoad = async () => {
      setConnecting(true);
      setError('');
      try {
        await window.electronAPI.ssh.host.connect(host.id);
        if (cancelled) return;

        let lastError: Error | null = null;
        for (const initialPath of initialPaths) {
          try {
            const entries = await window.electronAPI.ssh.fs.readDir(host.id, initialPath);
            if (cancelled) return;

            setRootEntries(entries);
            setCache(new Map([[initialPath, entries]]));
            setCurrentRootPath(initialPath);
            setSelectedPath(initialPath);
            setConnected(true);
            return;
          } catch (err) {
            lastError = err as Error;
          }
        }

        throw lastError ?? new Error('无法读取远程目录');
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
        }
      } finally {
        if (!cancelled) {
          setConnecting(false);
        }
      }
    };

    connectAndLoad();
    return () => {
      cancelled = true;
    };
  }, [open, host.id, initialPaths]);

  const dirEntries = rootEntries.filter((e) => e.type === 'directory');

  const handleConfirm = () => {
    if (selectedPath) {
      onSelect(host, selectedPath);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            {host.alias}
            <span className="text-xs text-muted-foreground font-normal">
              {host.user}@{host.host}:{host.port}
            </span>
          </DialogTitle>
        </DialogHeader>

        <DialogPanel>
          <div className="h-80 overflow-y-auto rounded-md border border-border/50">
            {connecting && (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在连接...
              </div>
            )}

            {error && !connecting && (
              <div className="flex h-full items-center justify-center text-sm text-destructive">
                {error}
              </div>
            )}

            {connected && dirEntries.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {currentRootPath || initialPaths[0]} 中没有找到目录
              </div>
            )}

            {connected && dirEntries.length > 0 && (
              <div className="py-1">
                {dirEntries.map((entry) => (
                  <RemoteDirNode
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    cache={cache}
                    setCache={setCache}
                    selectedPath={selectedPath}
                    onSelect={setSelectedPath}
                    hostId={host.id}
                  />
                ))}
              </div>
            )}
          </div>

          {selectedPath && (
            <div className="mt-2 rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
              已选择：<code className="text-foreground">{selectedPath}</code>
            </div>
          )}
        </DialogPanel>

        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedPath}>
            作为远程项目打开
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
