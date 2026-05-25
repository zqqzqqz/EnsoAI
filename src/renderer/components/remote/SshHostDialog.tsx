import type { RemoteHost, RemoteHostAuthType, SshTestConnectionResult } from '@shared/types';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSettingsStore } from '@/stores/settings';

interface SshHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editHost?: RemoteHost | null;
  onSave?: (host: RemoteHost) => void;
}

export function SshHostDialog({ open, onOpenChange, editHost, onSave }: SshHostDialogProps) {
  const upsertRemoteHost = useSettingsStore((s) => s.upsertRemoteHost);

  const [alias, setAlias] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [authType, setAuthType] = useState<RemoteHostAuthType>('password');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SshTestConnectionResult | null>(null);

  useEffect(() => {
    if (open) {
      if (editHost) {
        setAlias(editHost.alias);
        setHost(editHost.host);
        setPort(String(editHost.port));
        setUser(editHost.user);
        setAuthType(editHost.authType);
        setPrivateKeyPath(editHost.privateKeyPath ?? '');
      } else {
        setAlias('');
        setHost('');
        setPort('22');
        setUser('');
        setAuthType('password');
        setPrivateKeyPath('');
      }
      setPassword('');
      setPassphrase('');
      setError('');
      setTestResult(null);
    }
  }, [open, editHost]);

  const handleBrowseKey = useCallback(async () => {
    const result = await window.electronAPI.dialog.openFile({
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (result) {
      setPrivateKeyPath(result);
    }
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.ssh.host.test({
        host: {
          alias: alias || host,
          host,
          port: Number.parseInt(port, 10) || 22,
          user,
          authType,
          privateKeyPath: authType === 'privateKey' ? privateKeyPath : undefined,
        },
        password: authType === 'password' ? password : undefined,
        passphrase: authType === 'privateKey' ? passphrase : undefined,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, errorCode: 'UNKNOWN', errorMessage: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [alias, host, port, user, authType, password, privateKeyPath, passphrase]);

  const handleSave = useCallback(async () => {
    if (!host.trim()) {
      setError('请输入主机地址');
      return;
    }
    if (!user.trim()) {
      setError('请输入用户名');
      return;
    }
    const portNum = Number.parseInt(port, 10);
    if (!portNum || portNum < 1 || portNum > 65535) {
      setError('端口必须在 1-65535 之间');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const saved = await window.electronAPI.ssh.host.save({
        host: {
          ...(editHost ? { id: editHost.id } : {}),
          alias: alias.trim() || host.trim(),
          host: host.trim(),
          port: portNum,
          user: user.trim(),
          authType,
          privateKeyPath:
            authType === 'privateKey' ? privateKeyPath.trim() || undefined : undefined,
        },
        password: authType === 'password' ? password : undefined,
        passphrase: authType === 'privateKey' ? passphrase : undefined,
      });

      upsertRemoteHost(saved);
      onSave?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [
    alias,
    host,
    port,
    user,
    authType,
    password,
    privateKeyPath,
    passphrase,
    editHost,
    upsertRemoteHost,
    onSave,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editHost ? '编辑 SSH 主机' : '新建 SSH 主机'}</DialogTitle>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel>别名</FieldLabel>
              <Input
                value={alias}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value)}
                placeholder="我的服务器"
              />
            </Field>

            <div className="grid grid-cols-3 gap-2">
              <Field className="col-span-2">
                <FieldLabel>主机</FieldLabel>
                <Input
                  value={host}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHost(e.target.value)}
                  placeholder="192.168.1.100"
                />
              </Field>
              <Field>
                <FieldLabel>端口</FieldLabel>
                <Input
                  value={port}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPort(e.target.value)}
                  placeholder="22"
                />
              </Field>
            </div>

            <Field>
              <FieldLabel>用户</FieldLabel>
              <Input
                value={user}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUser(e.target.value)}
                placeholder="root"
              />
            </Field>

            <Field>
              <FieldLabel>认证方式</FieldLabel>
              <Select
                value={authType}
                onValueChange={(v: string | null) =>
                  setAuthType((v ?? 'password') as RemoteHostAuthType)
                }
              >
                <SelectTrigger>
                  <SelectValue>{authType === 'password' ? '密码' : '私钥'}</SelectValue>
                </SelectTrigger>
                <SelectItem value="password">密码</SelectItem>
                <SelectItem value="privateKey">私钥</SelectItem>
              </Select>
            </Field>

            {authType === 'password' && (
              <Field>
                <FieldLabel>密码</FieldLabel>
                <Input
                  type="password"
                  value={password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                  placeholder={editHost ? '留空则保留当前值' : '密码'}
                />
              </Field>
            )}

            {authType === 'privateKey' && (
              <>
                <Field>
                  <FieldLabel>私钥路径</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      value={privateKeyPath}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setPrivateKeyPath(e.target.value)
                      }
                      placeholder="~/.ssh/id_rsa"
                      className="flex-1"
                    />
                    <Button variant="outline" size="sm" onClick={handleBrowseKey}>
                      浏览
                    </Button>
                  </div>
                </Field>
                <Field>
                  <FieldLabel>密码短语（可选）</FieldLabel>
                  <Input
                    type="password"
                    value={passphrase}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setPassphrase(e.target.value)
                    }
                    placeholder={editHost ? '留空则保留当前值' : '密码短语'}
                  />
                </Field>
              </>
            )}

            {error && <div className="text-sm text-red-500">{error}</div>}

            {testResult && (
              <div className={`text-sm ${testResult.ok ? 'text-green-500' : 'text-red-500'}`}>
                {testResult.ok
                  ? `连接成功：${testResult.serverVersion}`
                  : `连接失败：${testResult.errorMessage}`}
              </div>
            )}
          </div>
        </DialogPanel>

        <DialogFooter variant="bare">
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleTest} disabled={testing || !host || !user}>
              {testing ? '测试中...' : '测试连接'}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : editHost ? '更新' : '创建'}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
