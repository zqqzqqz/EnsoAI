import type { RemoteHost } from '@shared/types';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, Circle, Server } from 'lucide-react';
import * as React from 'react';
import { useSettingsStore } from '@/stores/settings';

const COLLAPSED_STORAGE_KEY = 'enso-remote-host-collapsed-state';

function getCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    return raw ? JSON.parse(raw) : false;
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean): void {
  localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));
}

interface RemoteHostSectionProps {
  onEditHost?: (host: RemoteHost) => void;
}

export function RemoteHostSection({ onEditHost }: RemoteHostSectionProps) {
  const remoteHosts = useSettingsStore((s) => s.remoteHosts);
  const [collapsed, setCollapsed] = React.useState(getCollapsed);

  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(next);
      return next;
    });
  }, []);

  if (remoteHosts.length === 0) return null;

  return (
    <div className="border-t border-border/40 pt-1">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        <Server className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">SSH 主机</span>
        <span className="shrink-0 text-[10px] tabular-nums">{remoteHosts.length}</span>
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            {remoteHosts.map((host) => (
              <button
                key={host.id}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1 text-sm hover:bg-accent/50 transition-colors"
                onClick={() => onEditHost?.(host)}
              >
                <Circle className="h-2 w-2 shrink-0 fill-muted-foreground/30 text-muted-foreground/30" />
                <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{host.alias}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {host.user}@{host.host}:{host.port}
                  </div>
                </div>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
