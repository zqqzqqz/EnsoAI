import { Check, Copy, Download, ExternalLink, RefreshCw, Square } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

interface RemoteShareStatus {
  running: boolean;
  port?: number;
  url?: string;
  error?: string;
}

interface BoreStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  url?: string;
  error?: string;
}

export function SelfBuiltSharingTab() {
  const { t } = useI18n();
  const { remoteShareSettings, setRemoteShareSettings } = useSettingsStore();
  const [status, setStatus] = React.useState<RemoteShareStatus>({ running: false });
  const [loading, setLoading] = React.useState(false);

  // Bore state
  const [boreStatus, setBoreStatus] = React.useState<BoreStatus>({
    installed: false,
    running: false,
  });
  const [boreLoading, setBoreLoading] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [tokenCopied, setTokenCopied] = React.useState(false);

  // Local state for inputs
  const [localPort, setLocalPort] = React.useState(String(remoteShareSettings.port));
  const [localToken, setLocalToken] = React.useState(remoteShareSettings.authToken);
  const [localBoreServer, setLocalBoreServer] = React.useState(remoteShareSettings.boreServer);

  // Sync local state with store
  React.useEffect(() => {
    setLocalPort(String(remoteShareSettings.port));
    setLocalToken(remoteShareSettings.authToken);
    setLocalBoreServer(remoteShareSettings.boreServer);
  }, [remoteShareSettings]);

  // Fetch initial status
  React.useEffect(() => {
    window.electronAPI.remoteShare.getStatus().then((s) => {
      setStatus(s);
      setRemoteShareSettings({ enabled: s.running });
    });
    window.electronAPI.bore.check().then((result) => {
      setBoreStatus((prev) => ({ ...prev, ...result }));
    });
    window.electronAPI.bore.getStatus().then((s) => {
      setBoreStatus(s);
      setRemoteShareSettings({ boreEnabled: s.running });
    });

    const cleanupRs = window.electronAPI.remoteShare.onStatusChanged((newStatus) => {
      setStatus(newStatus);
      setRemoteShareSettings({ enabled: newStatus.running });
    });
    const cleanupBore = window.electronAPI.bore.onStatusChanged((newStatus) => {
      setBoreStatus(newStatus);
      setRemoteShareSettings({ boreEnabled: newStatus.running });
    });

    return () => {
      cleanupRs();
      cleanupBore();
    };
  }, [setRemoteShareSettings]);

  const handleEnabledChange = async (enabled: boolean) => {
    setLoading(true);
    try {
      if (enabled) {
        const port = Number(localPort) || 3007;
        const token = localToken || '';
        setRemoteShareSettings({ enabled: true, port, authToken: token });
        const result = await window.electronAPI.remoteShare.start({ port, authToken: token });
        // If server generated a token, save it
        if (result.generatedToken) {
          setLocalToken(result.generatedToken);
          setRemoteShareSettings({ authToken: result.generatedToken });
        }
      } else {
        // Also stop bore
        if (remoteShareSettings.boreEnabled) {
          await window.electronAPI.bore.stop();
          setRemoteShareSettings({ boreEnabled: false });
        }
        await window.electronAPI.remoteShare.stop();
        setRemoteShareSettings({ enabled: false });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      if (remoteShareSettings.boreEnabled) {
        await window.electronAPI.bore.stop();
        setRemoteShareSettings({ boreEnabled: false });
      }
      await window.electronAPI.remoteShare.stop();
      setRemoteShareSettings({ enabled: false });
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = async () => {
    setLoading(true);
    const port = Number(localPort) || 3007;
    const token = localToken || '';
    setRemoteShareSettings({ port, authToken: token });
    try {
      await window.electronAPI.remoteShare.stop();
      const result = await window.electronAPI.remoteShare.start({ port, authToken: token });
      if (result.generatedToken) {
        setLocalToken(result.generatedToken);
        setRemoteShareSettings({ authToken: result.generatedToken });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateToken = () => {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    setLocalToken(token);
    setRemoteShareSettings({ authToken: token });
  };

  // Bore handlers
  const handleBoreInstall = async () => {
    setBoreLoading(true);
    try {
      const result = await window.electronAPI.bore.install();
      setBoreStatus((prev) => ({ ...prev, ...result }));
    } finally {
      setBoreLoading(false);
    }
  };

  const handleBoreEnabledChange = async (enabled: boolean) => {
    setBoreLoading(true);
    try {
      if (enabled) {
        await window.electronAPI.bore.start({
          port: Number(localPort) || 3007,
          server: localBoreServer || 'bore.pub',
        });
        setRemoteShareSettings({ boreEnabled: true });
      } else {
        await window.electronAPI.bore.stop();
        setRemoteShareSettings({ boreEnabled: false });
      }
    } finally {
      setBoreLoading(false);
    }
  };

  const handleCopyUrl = async () => {
    const url = boreStatus.url || status.url;
    if (url) {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('Self-Built Remote Sharing')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Built-in WebSocket server for sharing terminals and files via browser')}
        </p>
      </div>

      {/* Enable Switch */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <span className="text-sm font-medium">{t('Enable Remote Sharing')}</span>
          <p className="text-xs text-muted-foreground">
            {t('Start WebSocket server for remote access')}
            {status.running && status.port && ` (Port: ${status.port})`}
          </p>
        </div>
        <Switch
          checked={remoteShareSettings.enabled}
          onCheckedChange={handleEnabledChange}
          disabled={loading}
        />
      </div>

      {/* Error display */}
      {status.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {status.error}
        </div>
      )}

      {/* Controls when running */}
      {remoteShareSettings.enabled && (
        <>
          {status.running && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleStop} disabled={loading}>
                <Square className="mr-1.5 h-3.5 w-3.5" />
                {t('Stop')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleRestart} disabled={loading}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('Restart')}
              </Button>
            </div>
          )}

          {/* Bore Tunnel Section */}
          <div className="space-y-4 border-t pt-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <span className="text-sm font-medium">{t('Public Access (Bore)')}</span>
                <p className="text-xs text-muted-foreground">
                  {t('Expose local server to the internet via bore tunnel')}
                </p>
              </div>
              <Switch
                checked={remoteShareSettings.boreEnabled}
                onCheckedChange={handleBoreEnabledChange}
                disabled={boreLoading || !boreStatus.installed || !status.running}
              />
            </div>

            {/* Install */}
            <div className="flex items-center gap-3">
              {boreStatus.installed ? (
                <span className="text-xs text-muted-foreground">bore {boreStatus.version}</span>
              ) : (
                <span className="text-xs text-muted-foreground">{t('Not installed')}</span>
              )}
              {!boreStatus.installed && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBoreInstall}
                  disabled={boreLoading}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {boreLoading ? t('Installing...') : t('Install')}
                </Button>
              )}
            </div>

            {/* Bore error */}
            {boreStatus.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {boreStatus.error}
              </div>
            )}

            {/* Public URL when running */}
            {boreStatus.running && boreStatus.url && (
              <div className="flex items-center gap-2 rounded-md bg-accent/50 p-3">
                <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
                <code className="flex-1 truncate text-xs">{boreStatus.url}</code>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleCopyUrl}>
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            )}

            {/* Bore Server URL */}
            <div className="grid grid-cols-[140px_1fr] items-center gap-4">
              <span className="text-sm font-medium">{t('Bore Server')}</span>
              <div className="space-y-1.5">
                <Input
                  type="text"
                  value={localBoreServer}
                  onChange={(e) => setLocalBoreServer(e.target.value)}
                  onBlur={() => setRemoteShareSettings({ boreServer: localBoreServer })}
                  placeholder="bore.pub"
                  className="flex-1 font-mono text-xs"
                  disabled={boreStatus.running}
                />
                <p className="text-xs text-muted-foreground">{t('Bore relay server address')}</p>
              </div>
            </div>
          </div>

          {/* Configuration */}
          <div className="space-y-4 border-t pt-4">
            <h4 className="text-sm font-medium text-muted-foreground">{t('Configuration')}</h4>

            {/* Server Port */}
            <div className="grid grid-cols-[140px_1fr] items-center gap-4">
              <span className="text-sm font-medium">{t('Server Port')}</span>
              <div className="space-y-1.5">
                <Input
                  type="number"
                  value={localPort}
                  onChange={(e) => setLocalPort(e.target.value)}
                  onBlur={() => setRemoteShareSettings({ port: Number(localPort) || 3007 })}
                  min={1024}
                  max={65535}
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">{t('Server listening port')}</p>
              </div>
            </div>

            {/* Access Token */}
            <div className="grid grid-cols-[140px_1fr] items-center gap-4">
              <span className="text-sm font-medium">{t('Access Token')}</span>
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={localToken}
                    onChange={(e) => setLocalToken(e.target.value)}
                    onBlur={() => setRemoteShareSettings({ authToken: localToken })}
                    placeholder={t('Auto-generated if empty')}
                    className="flex-1 font-mono text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 shrink-0"
                    onClick={async () => {
                      if (localToken) {
                        await navigator.clipboard.writeText(localToken);
                        setTokenCopied(true);
                        setTimeout(() => setTokenCopied(false), 2000);
                      }
                    }}
                  >
                    {tokenCopied ? (
                      <Check className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleGenerateToken}>
                    {t('Generate')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('Access token for web UI authentication')}
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
