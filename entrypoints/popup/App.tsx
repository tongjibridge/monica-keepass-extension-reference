import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IconArrowLeft,
  IconCloud,
  IconDownload,
  IconEye,
  IconFile,
  IconFingerprint,
  IconFolder,
  IconKey,
  IconLoader2,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
  IconUpload,
  IconWand,
} from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@/src/components/ui/alert';
import { Button } from '@/src/components/ui/button';
import { Card } from '@/src/components/ui/card';
import { CheckboxField } from '@/src/components/ui/checkbox';
import { CopyIconButton } from '@/src/components/ui/copy-button';
import { Field } from '@/src/components/ui/field';
import { Input } from '@/src/components/ui/input';
import { PasswordInput } from '@/src/components/ui/password-input';
import { Separator } from '@/src/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { Textarea } from '@/src/components/ui/textarea';
import { Tooltip } from '@/src/components/ui/tooltip';
import {
  base64ToBytes,
  bytesToBase64,
  callBackground,
  type CredentialInput,
  type OneDriveStatus,
  type VaultStatus,
} from '@/src/messaging/protocol';
import { DEFAULT_ONEDRIVE_CLIENT_ID, type OneDriveListItem } from '@/src/onedrive/graph';
import type { EntryDetail, EntrySummary, KdfInfo, NewEntryInput } from '@/src/vault/types';
import { clearHello, enrollHello, isHelloAvailable, unlockWithHello } from '@/src/hello/webauthn';
import { Generator } from './Generator';

type View =
  | 'loading'
  | 'setup'
  | 'locked'
  | 'list'
  | 'detail'
  | 'form'
  | 'generator'
  | 'settings'
  | 'backup';

function describeError(e: unknown): string {
  if (e instanceof DOMException) return `${e.name}: ${e.message || 'WebAuthn request failed'}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [view, setView] = useState<View>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [selected, setSelected] = useState<EntryDetail | null>(null);
  const [credential, setCredential] = useState<CredentialInput | null>(null);

  const refreshStatus = useCallback(async (): Promise<VaultStatus> => {
    const s = await callBackground({ type: 'vault.status' });
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    refreshStatus().then((s) => {
      setView(!s.hasVault ? 'setup' : s.unlocked ? 'list' : 'locked');
    });
  }, [refreshStatus]);

  const loadEntries = useCallback(async () => {
    setEntries(await callBackground({ type: 'vault.listEntries' }));
  }, []);

  useEffect(() => {
    if (view === 'list') loadEntries().catch((e) => setError(describeError(e)));
  }, [view, loadEntries]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    await waitForPaint();
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const lock = () =>
    run(async () => {
      await callBackground({ type: 'vault.lock' });
      setCredential(null);
      setEntries([]);
      setSelected(null);
      await refreshStatus();
      setView('locked');
    });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-14 min-w-0 items-center justify-between gap-3 bg-background/95 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/icons/icon-32.png" alt="" className="size-7" />
          <h1 className="truncate text-[18px] font-medium tracking-[-0.3px]">Monica KeePass</h1>
        </div>
        {status?.unlocked && (
          <div className="shrink-0 flex items-center gap-0.5">
            <Tooltip label="Password generator">
              <Button variant="ghost" size="iconSm" onClick={() => setView('generator')}>
                <IconWand className="size-5" />
              </Button>
            </Tooltip>
            <Tooltip label="Settings">
              <Button variant="ghost" size="iconSm" onClick={() => setView('settings')}>
                <IconSettings className="size-5" />
              </Button>
            </Tooltip>
            <Tooltip label="Lock vault">
              <Button variant="ghost" size="iconSm" onClick={lock}>
                <IconLock className="size-5" />
              </Button>
            </Tooltip>
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-4 pt-3">
        {error && (
          <Alert variant="destructive" className="mb-4" onClose={() => setError('')}>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {status?.pending && (
          <PendingBanner
            status={status}
            busy={busy}
            onApply={(entryId) =>
              run(async () => {
                await callBackground({
                  type: 'vault.applyPending',
                  pendingId: status.pending!.id,
                  ...(entryId ? { entryId } : {}),
                });
                await refreshStatus();
                if (view === 'list') await loadEntries();
              })
            }
            onDismiss={() =>
              run(async () => {
                await callBackground({
                  type: 'vault.dismissPending',
                  pendingId: status.pending!.id,
                });
                await refreshStatus();
              })
            }
          />
        )}

        {view === 'loading' && (
          <div className="flex min-h-[300px] items-center justify-center">
            <IconLoader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {view === 'setup' && (
          <SetupView
            busy={busy}
            canGoBack={status?.hasVault ?? false}
            onBack={() => setView('locked')}
            onCreate={(name, password) =>
              run(async () => {
                await callBackground({ type: 'vault.createNew', name, password });
                setCredential({ password });
                await refreshStatus();
                setView('list');
              })
            }
            onImport={(name, dataB64) =>
              run(async () => {
                await callBackground({ type: 'vault.import', name, data: dataB64 });
                await refreshStatus();
                setView('locked');
              })
            }
            onOneDriveSelected={async () => {
              const s = await refreshStatus();
              setView(s.unlocked ? 'list' : 'locked');
            }}
            setError={setError}
          />
        )}

        {view === 'locked' && status && (
          <LockedView
            busy={busy}
            status={status}
            error={error}
            onSwitchVault={() => {
              setError('');
              setView('setup');
            }}
            onUnlock={(cred, rememberKeyFile) =>
              run(async () => {
                await callBackground({ type: 'vault.unlock', credential: cred, rememberKeyFile });
                setCredential(cred);
                await refreshStatus();
                setView('list');
              })
            }
            onHello={() =>
              run(async () => {
                const cred = await unlockWithHello();
                await callBackground({ type: 'vault.unlock', credential: cred });
                setCredential(cred);
                await refreshStatus();
                setView('list');
              })
            }
          />
        )}

        {view === 'list' && (
          <ListView
            entries={entries}
            onOpen={(id) =>
              run(async () => {
                setSelected(await callBackground({ type: 'vault.getEntry', id, reveal: false }));
                setView('detail');
              })
            }
            onAdd={() => {
              setSelected(null);
              setView('form');
            }}
          />
        )}

        {view === 'detail' && selected && (
          <DetailView
            entry={selected}
            onReveal={() =>
              run(async () => {
                setSelected(
                  await callBackground({ type: 'vault.getEntry', id: selected.id, reveal: true }),
                );
              })
            }
            onEdit={() => setView('form')}
            onDelete={() =>
              run(async () => {
                await callBackground({ type: 'vault.delete', id: selected.id });
                await loadEntries();
                setSelected(null);
                setView('list');
              })
            }
            onBack={() => setView('list')}
          />
        )}

        {view === 'form' && (
          <EntryForm
            existing={selected}
            busy={busy}
            onCancel={() => setView(selected ? 'detail' : 'list')}
            onSave={(input) =>
              run(async () => {
                if (selected) {
                  await callBackground({
                    type: 'vault.update',
                    input: { id: selected.id, ...input },
                  });
                } else {
                  await callBackground({ type: 'vault.add', input });
                }
                await loadEntries();
                setView('list');
              })
            }
          />
        )}

        {view === 'generator' && (
          <div className="grid gap-3">
            <Generator />
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setView(status?.unlocked ? 'list' : 'locked')}>
                Done
              </Button>
            </div>
          </div>
        )}

        {view === 'settings' && status && (
          <SettingsView
            status={status}
            credential={credential}
            onChanged={refreshStatus}
            onBack={() => setView('list')}
            onOpenBackup={() => setView('backup')}
            setError={setError}
          />
        )}

        {view === 'backup' && status && (
          <BackupView
            status={status}
            onBack={() => setView('settings')}
            onAfterImport={async () => {
              setCredential(null);
              setEntries([]);
              setSelected(null);
              const s = await refreshStatus();
              setView(s.unlocked ? 'list' : 'locked');
            }}
            setError={setError}
          />
        )}
      </main>

      {view === 'locked' && busy && <UnlockingOverlay />}
    </div>
  );
}

function UnlockingOverlay() {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 px-6 backdrop-blur-sm" aria-live="polite">
      <div className="grid w-full max-w-[280px] place-items-center gap-3 rounded-[24px] border border-border bg-card p-5 text-center shadow-[0_8px_24px_rgba(60,64,67,0.14)]">
        <div className="monica-unlock-ring" aria-hidden="true" />
        <div className="grid gap-1">
          <p className="text-sm font-medium">Unlocking vault</p>
          <p className="text-xs text-muted-foreground">Please wait while Monica KeePass decrypts your vault.</p>
        </div>
      </div>
    </div>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="mb-1 inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
      onClick={onClick}
    >
      <IconArrowLeft className="size-3.5" />
      {label}
    </button>
  );
}

function FileField({
  label,
  accept,
  onFile,
}: {
  label?: string;
  accept?: string;
  onFile: (file: File | null) => void;
}) {
  const input = (
    <Input
      type="file"
      accept={accept}
      onChange={(e) => onFile(e.currentTarget.files?.[0] ?? null)}
    />
  );
  return label ? <Field label={label}>{input}</Field> : input;
}

function SetupView({
  busy,
  canGoBack,
  onBack,
  onCreate,
  onImport,
  onOneDriveSelected,
  setError,
}: {
  busy: boolean;
  canGoBack: boolean;
  onBack: () => void;
  onCreate: (name: string, password: string) => void;
  onImport: (name: string, dataB64: string) => void;
  onOneDriveSelected: () => Promise<void>;
  setError: (e: string) => void;
}) {
  const [mode, setMode] = useState<'create' | 'import' | 'onedrive'>('create');
  const [name, setName] = useState('My Vault');
  const [password, setPassword] = useState('');

  const handleFile = async (file: File | null) => {
    if (!file) return;
    onImport(file.name, bytesToBase64(await file.arrayBuffer()));
  };

  return (
    <div className="grid gap-3">
      {canGoBack && <BackLink label="Back to unlock" onClick={onBack} />}
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'create' | 'import' | 'onedrive')}>
        <TabsList>
          <TabsTrigger value="create">Create</TabsTrigger>
          <TabsTrigger value="import">导入</TabsTrigger>
          <TabsTrigger value="onedrive">OneDrive</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === 'create' && (
        <>
          <Field label="Vault name">
            <Input value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Field label="Master password">
            <PasswordInput value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
          </Field>
          <Button disabled={busy || !password || !name} onClick={() => onCreate(name, password)}>
            Create vault
          </Button>
        </>
      )}

      {mode === 'import' && (
        <>
          <p className="text-sm text-muted-foreground">
            Select an existing KeePass .kdbx file to manage in this browser.
          </p>
          <FileField accept=".kdbx" onFile={handleFile} />
        </>
      )}

      {mode === 'onedrive' && (
        <OneDriveVaultPicker onSelected={onOneDriveSelected} setError={setError} />
      )}
    </div>
  );
}

// Connect to OneDrive and pick a .kdbx, usable before any vault exists (first
// run). Reuses the same background handlers as Settings; on selection it pulls
// the file locally so the caller can move to the unlock screen.
function OneDriveVaultPicker({
  onSelected,
  setError,
}: {
  onSelected: () => Promise<void>;
  setError: (e: string) => void;
}) {
  const [odStatus, setOdStatus] = useState<OneDriveStatus | null>(null);
  const [clientId, setClientId] = useState(DEFAULT_ONEDRIVE_CLIENT_ID);
  const [folder, setFolder] = useState('');
  const [items, setItems] = useState<OneDriveListItem[]>([]);
  const [busy, setBusy] = useState(false);

  const loadFolder = async (path: string) => {
    setFolder(path);
    setItems(await callBackground({ type: 'onedrive.list', path }));
  };

  useEffect(() => {
    callBackground({ type: 'onedrive.status' })
      .then((s) => {
        setOdStatus(s);
        if (s.config?.clientId) setClientId(s.config.clientId);
        if (s.connected) loadFolder('').catch((e) => setError(describeError(e)));
      })
      .catch((e) => setError(describeError(e)));
  }, [setError]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    run(async () => {
      await callBackground({ type: 'onedrive.configure', clientId, remotePath: '' });
      await callBackground({ type: 'onedrive.connect' });
      setOdStatus(await callBackground({ type: 'onedrive.status' }));
      await loadFolder('');
    });

  const pick = (item: OneDriveListItem) =>
    run(async () => {
      await callBackground({ type: 'onedrive.configure', clientId, remotePath: item.path });
      await callBackground({ type: 'onedrive.pull' });
      await onSelected();
    });

  const goUp = () =>
    run(() => loadFolder(folder.split('/').slice(0, -1).join('/')));

  if (!odStatus?.connected) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Connect OneDrive and pick a KeePass .kdbx to manage in this browser.
        </p>
        <Field
          label="Microsoft client ID"
          description="使用 the default app registration or your own."
        >
          <Input value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
        </Field>
        {odStatus?.redirectUrl && (
          <p className="break-all text-xs text-muted-foreground">
            重定向 URI： {odStatus.redirectUrl}
          </p>
        )}
        <Button loading={busy} disabled={!clientId} onClick={connect}>
          <IconCloud className="size-4" />
          Connect OneDrive
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">Pick a .kdbx file to use.</p>
      <Card className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="break-all text-xs text-muted-foreground">/{folder}</p>
          <div className="flex items-center gap-1">
            {folder && (
              <Button size="xs" variant="outline" disabled={busy} onClick={goUp}>
                Up
              </Button>
            )}
            <Button
              variant="ghost"
              size="iconSm"
              loading={busy}
              onClick={() => run(() => loadFolder(folder))}
            >
              <IconRefresh className="size-4" />
            </Button>
          </div>
        </div>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">这里没有文件夹或 .kdbx 文件。</p>
        ) : (
          <div className="grid gap-1">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                {item.isFolder ? (
                  <IconFolder className="size-4 shrink-0 text-amber-500" />
                ) : (
                  <IconFile className="size-4 shrink-0 text-primary" />
                )}
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded px-1 py-0.5 text-left hover:bg-secondary"
                  onClick={() =>
                    item.isFolder
                      ? run(() => loadFolder(item.path))
                      : pick(item)
                  }
                >
                  <p className="max-w-[220px] truncate text-sm">{item.name}</p>
                </button>
                {!item.isFolder && (
                  <Button size="xs" variant="soft" loading={busy} onClick={() => pick(item)}>
                    Use
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function LockedView({
  busy,
  status,
  error,
  onSwitchVault,
  onUnlock,
  onHello,
}: {
  busy: boolean;
  status: VaultStatus;
  error: string;
  onSwitchVault: () => void;
  onUnlock: (credential: CredentialInput, rememberKeyFile: boolean) => void;
  onHello: () => void;
}) {
  const [password, setPassword] = useState('');
  const [keyFileB64, setKeyFileB64] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);

  const pickKeyFile = async (file: File | null) => {
    if (!file) {
      setKeyFileB64(null);
      return;
    }
    setKeyFileB64(bytesToBase64(await file.arrayBuffer()));
  };

  const canUnlock = Boolean(password || keyFileB64 || status.rememberedKeyFile);
  const submit = () =>
    onUnlock({ password: password || null, keyFile: keyFileB64 ?? undefined }, remember);

  const isLockedDown = status.lockdownUntil != null && Date.now() < status.lockdownUntil;

  return (
    <div className="grid gap-3">
      {isLockedDown && (
        <Alert variant="destructive">
          <IconLock className="size-4" />
          <AlertTitle>已锁定</AlertTitle>
          <AlertDescription>
            密码错误次数过多，请等待倒计时结束后重试。
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Field label="Master password" description="Leave empty for a key-file-only vault">
        <PasswordInput
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && canUnlock && !isLockedDown && submit()}
        />
      </Field>

      {status.rememberedKeyFile && !keyFileB64 ? (
        <p className="text-sm text-muted-foreground">Using remembered key file on this device.</p>
      ) : (
        <FileField label="密钥文件（可选）" onFile={pickKeyFile} />
      )}
      {keyFileB64 && (
        <CheckboxField
          label="Remember key file on this device"
          checked={remember}
          onCheckedChange={setRemember}
        />
      )}

      <Button disabled={busy || !canUnlock || isLockedDown} onClick={submit}>
        Unlock
      </Button>
      {status.helloEnrolled && (
        <Button variant="outline" disabled={busy || isLockedDown} onClick={onHello}>
          <IconFingerprint className="size-4.5" />
          Unlock with Windows Hello
        </Button>
      )}
      <button
        type="button"
        className="mx-auto text-sm text-muted-foreground hover:text-foreground hover:underline"
        onClick={onSwitchVault}
      >
        Use a different vault…
      </button>
    </div>
  );
}

function ListView({
  entries,
  onOpen,
  onAdd,
}: {
  entries: EntrySummary[];
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q) ||
        e.url.toLowerCase().includes(q),
    );
  }, [entries, query]);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Input
          type="search"
          className="min-w-0 flex-1"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Tooltip label="Add entry">
          <Button size="icon" onClick={onAdd}>
            <IconPlus className="size-4.5" />
          </Button>
        </Tooltip>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-4 text-center text-sm text-muted-foreground">No entries.</p>
      ) : (
        <div className="grid min-w-0 gap-2">
          {filtered.map((e) => (
            <button
              key={e.id}
              type="button"
              className="max-w-full overflow-hidden rounded-2xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/60"
              onClick={() => onOpen(e.id)}
            >
              <p className="truncate text-[15px] font-medium">{e.title || '(untitled)'}</p>
              <p className="truncate text-xs text-muted-foreground">{e.username || e.url}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <p className="flex-1 break-all text-sm">{value}</p>
        <CopyIconButton value={value} />
      </div>
    </div>
  );
}

function DetailView({
  entry,
  onReveal,
  onEdit,
  onDelete,
  onBack,
}: {
  entry: EntryDetail;
  onReveal: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  return (
    <div className="grid gap-3">
      <BackLink label="返回" onClick={onBack} />
      <h2 className="text-lg font-medium tracking-[-0.2px]">{entry.title || '(untitled)'}</h2>

      <CopyRow label="Username" value={entry.username} />

      <div>
        <p className="text-xs text-muted-foreground">Password</p>
        <div className="flex items-center gap-2">
          <p className="flex-1 break-all font-mono text-sm">{entry.password ?? '••••••••'}</p>
          {entry.password ? (
            <CopyIconButton value={entry.password} />
          ) : (
            <Tooltip label="Reveal">
              <Button variant="ghost" size="iconSm" onClick={onReveal}>
                <IconEye className="size-4" />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <CopyRow label="URL" value={entry.url} />
      <CopyRow label="Notes" value={entry.notes} />

      <div className="mt-2 flex gap-2">
        <Button onClick={onEdit}>Edit</Button>
        <Button variant="softDestructive" onClick={onDelete}>
          <IconTrash className="size-4" />
          Delete
        </Button>
      </div>
    </div>
  );
}

function EntryForm({
  existing,
  busy,
  onSave,
  onCancel,
}: {
  existing: EntryDetail | null;
  busy: boolean;
  onSave: (input: NewEntryInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [username, setUsername] = useState(existing?.username ?? '');
  const [password, setPassword] = useState(existing?.password ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [showGen, setShowGen] = useState(false);

  return (
    <div className="grid gap-3">
      <BackLink label="Cancel" onClick={onCancel} />
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
      </Field>
      <Field label="Username">
        <Input value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
      </Field>
      <Field label="Password">
        <div className="relative">
          <Input
            className="pe-9 font-mono"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <button
            type="button"
            title="Generate"
            className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => setShowGen((v) => !v)}
          >
            <IconWand className="size-4" />
          </button>
        </div>
      </Field>
      {showGen && (
        <Card>
          <Generator
            onUse={(pw) => {
              setPassword(pw);
              void navigator.clipboard.writeText(pw).catch(() => undefined);
              setShowGen(false);
            }}
          />
        </Card>
      )}
      <Field label="URL">
        <Input value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
      </Field>
      <Field label="Notes">
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
      </Field>
      <div className="flex justify-end">
        <Button disabled={busy} onClick={() => onSave({ title, username, password, url, notes })}>
          Save
        </Button>
      </div>
    </div>
  );
}

function SettingsView({
  status,
  credential,
  onChanged,
  onBack,
  onOpenBackup,
  setError,
}: {
  status: VaultStatus;
  credential: CredentialInput | null;
  onChanged: () => Promise<VaultStatus>;
  onBack: () => void;
  onOpenBackup: () => void;
  setError: (e: string) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [helloBusy, setHelloBusy] = useState(false);
  const [oneDrive, setOneDrive] = useState<OneDriveStatus | null>(null);
  const [oneDriveClientId, setOneDriveClientId] = useState(DEFAULT_ONEDRIVE_CLIENT_ID);
  const [oneDriveRemotePath, setOneDriveRemotePath] = useState('');
  const [oneDriveFolder, setOneDriveFolder] = useState('');
  const [oneDriveItems, setOneDriveItems] = useState<OneDriveListItem[]>([]);
  const [oneDriveBusy, setOneDriveBusy] = useState(false);
  const [oneDriveMessage, setOneDriveMessage] = useState('');
  const [kdf, setKdf] = useState<KdfInfo | null>(null);
  const [kdfBusy, setKdfBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState('');

  useEffect(() => {
    isHelloAvailable().then(setAvailable);
    callBackground({ type: 'vault.kdfInfo' })
      .then(setKdf)
      .catch(() => setKdf(null));
  }, []);

  const importCsvFile = async (file: File | null) => {
    if (!file || importBusy) return;
    setImportBusy(true);
    setImportMsg('');
    setError('');
    try {
      const csv = await file.text();
      const result = await callBackground({ type: 'vault.importCsv', csv });
      setImportMsg(
        `Imported ${result.imported} of ${result.total}` +
          (result.skipped ? `, skipped ${result.skipped} already present.` : '.'),
      );
      await onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setImportBusy(false);
    }
  };

  const applyKdf = async (profile: 'fast' | 'balanced' | 'secure') => {
    if (kdfBusy) return;
    setKdfBusy(true);
    setError('');
    try {
      setKdf(await callBackground({ type: 'vault.setKdf', profile }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setKdfBusy(false);
    }
  };

  useEffect(() => {
    callBackground({ type: 'onedrive.status' })
      .then((s) => {
        setOneDrive(s);
        if (s.config) {
          setOneDriveClientId(s.config.clientId);
          setOneDriveRemotePath(s.config.remotePath);
        }
        if (s.connected) loadOneDriveFolder('').catch((e) => setError(describeError(e)));
      })
      .catch((e) => setError(describeError(e)));
  }, [setError]);

  const enable = async () => {
    if (helloBusy) return;
    setHelloBusy(true);
    setError('');
    try {
      if (!credential) throw new Error('Re-unlock the vault to enable Windows Hello');
      await enrollHello(credential);
      await onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setHelloBusy(false);
    }
  };

  const disable = async () => {
    if (helloBusy) return;
    setHelloBusy(true);
    try {
      await clearHello();
      await onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setHelloBusy(false);
    }
  };

  const forgetKeyFile = async () => {
    await callBackground({ type: 'vault.forgetKeyFile' });
    await onChanged();
  };

  const runOneDrive = async (fn: () => Promise<string>) => {
    if (oneDriveBusy) return;
    setOneDriveBusy(true);
    setOneDriveMessage('');
    setError('');
    try {
      const message = await fn();
      setOneDriveMessage(message);
      const s = await callBackground({ type: 'onedrive.status' });
      setOneDrive(s);
      if (s.config) {
        setOneDriveClientId(s.config.clientId);
        setOneDriveRemotePath(s.config.remotePath);
      }
      await onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setOneDriveBusy(false);
    }
  };

  const saveOneDriveConfig = async () =>
    runOneDrive(async () => {
      await callBackground({
        type: 'onedrive.configure',
        clientId: oneDriveClientId,
        remotePath: oneDriveRemotePath,
      });
      return 'OneDrive settings saved.';
    });

  const loadOneDriveFolder = async (path: string) => {
    setOneDriveFolder(path);
    setOneDriveItems(await callBackground({ type: 'onedrive.list', path }));
  };

  const connectOneDrive = async () =>
    runOneDrive(async () => {
      await callBackground({
        type: 'onedrive.configure',
        clientId: oneDriveClientId,
        remotePath: oneDriveRemotePath,
      });
      const result = await callBackground({ type: 'onedrive.connect' });
      await loadOneDriveFolder('');
      return result.message;
    });

  const disconnectOneDrive = async () =>
    runOneDrive(async () => {
      await callBackground({ type: 'onedrive.disconnect' });
      return 'OneDrive disconnected on this browser.';
    });

  const oneDriveAction = async (type: 'onedrive.pull' | 'onedrive.push' | 'onedrive.sync') =>
    runOneDrive(async () => {
      await callBackground({
        type: 'onedrive.configure',
        clientId: oneDriveClientId,
        remotePath: oneDriveRemotePath,
      });
      const result =
        type === 'onedrive.sync'
          ? await callBackground({ type, credential })
          : await callBackground({ type });
      return result.conflictPath ? `${result.message} ${result.conflictPath}` : result.message;
    });

  const selectOneDriveVault = async (item: OneDriveListItem) =>
    runOneDrive(async () => {
      setOneDriveRemotePath(item.path);
      await callBackground({
        type: 'onedrive.configure',
        clientId: oneDriveClientId,
        remotePath: item.path,
      });
      const result = await callBackground({ type: 'onedrive.pull' });
      return `已选择 ${item.name}。${result.message}`;
    });

  const goUpOneDriveFolder = () => {
    const parent = oneDriveFolder.split('/').slice(0, -1).join('/');
    runOneDrive(async () => {
      await loadOneDriveFolder(parent);
      return '';
    });
  };

  return (
    <div className="grid gap-3">
      <BackLink label="Back" onClick={onBack} />
      <h2 className="text-lg font-medium">设置</h2>

      <div>
        <p className="text-xs text-muted-foreground">密码库</p>
        <p className="text-sm">
          {status.meta?.name} · {status.meta?.entryCount} 个条目
        </p>
      </div>

      <Separator />

      <div className="grid gap-1.5">
        <p className="text-sm font-medium">Windows Hello</p>
        {available === false && (
          <p className="text-xs text-muted-foreground">
            此设备没有可用的平台认证器。
          </p>
        )}
        {status.helloEnrolled ? (
          <Button variant="softDestructive" className="w-fit" loading={helloBusy} onClick={disable}>
            停用 Windows Hello
          </Button>
        ) : (
          <Button
            className="w-fit"
            disabled={available !== true || !credential}
            loading={helloBusy}
            onClick={enable}
          >
            <IconFingerprint className="size-4.5" />
            启用 Windows Hello
          </Button>
        )}
      </div>

      {status.rememberedKeyFile && (
        <>
          <Separator />
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">密钥文件</p>
            <Button variant="softDestructive" className="w-fit" onClick={forgetKeyFile}>
              忘记已记住的密钥文件
            </Button>
          </div>
        </>
      )}

      <Separator />

      <div className="grid gap-1.5">
        <p className="text-sm font-medium">导入密码</p>
        <p className="text-xs text-muted-foreground">
          导入从 Chrome、Edge 或其他浏览器导出的 CSV。已有的
          URL + 用户名条目会自动跳过。
        </p>
        <FileField accept=".csv,text/csv" onFile={importCsvFile} />
        {importBusy && <p className="text-xs text-muted-foreground">正在导入...</p>}
        {importMsg && (
          <Alert variant="success">
            <AlertDescription>{importMsg}</AlertDescription>
          </Alert>
        )}
      </div>

      <Separator />

      <div className="grid gap-1.5">
        <p className="text-sm font-medium">加密强度</p>
        <p className="text-xs text-muted-foreground">
          强度越高，抗暴力破解越强，但解锁和保存会更慢。
          {kdf && (
            <>
              {' '}
              当前：{kdf.kdf === 'aes' ? 'AES-KDF' : kdf.kdf}，{kdf.memoryKiB} KiB · {kdf.iterations}{' '}
              次迭代。
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {(['fast', 'balanced', 'secure'] as const).map((p) => (
            <Button
              key={p}
              size="sm"
              variant={kdf?.profile === p ? 'default' : 'outline'}
              loading={kdfBusy}
              onClick={() => applyKdf(p)}
            >
              {p === 'fast' ? '快速' : p === 'balanced' ? '均衡' : '安全'}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          快速 ≈ 19 MiB · 均衡 ≈ 64 MiB · 安全 ≈ 256 MiB。会重新加密一次密码库；
          下次解锁开始生效。
        </p>
      </div>

      <Separator />

      <div className="grid gap-1.5">
        <p className="text-sm font-medium">备份与恢复</p>
        <p className="text-xs text-muted-foreground">
          将扩展数据打包成单个加密文件，方便迁移到其他设备。
        </p>
        <Button variant="soft" className="w-fit" onClick={onOpenBackup}>
          <IconDownload className="size-4" />
          打开备份与恢复
        </Button>
      </div>

      <Separator />

      <div className="grid gap-2">
        <div className="flex items-center gap-1.5">
          <IconCloud className="size-4.5" />
          <p className="text-sm font-medium">OneDrive</p>
        </div>
        {oneDriveMessage && (
          <Alert variant="success">
            <AlertDescription>{oneDriveMessage}</AlertDescription>
          </Alert>
        )}
        <Field label="已选择的 OneDrive 密码库">
          <Input
            placeholder="连接并选择 .kdbx 文件"
            value={oneDriveRemotePath}
            onChange={(e) => setOneDriveRemotePath(e.currentTarget.value)}
          />
        </Field>
        {oneDrive?.redirectUrl && (
          <p className="break-all text-xs text-muted-foreground">
            Redirect URI: {oneDrive.redirectUrl}
          </p>
        )}
        {oneDrive?.sync?.lastSuccessAt && (
          <p className="text-xs text-muted-foreground">
            上次同步：{new Date(oneDrive.sync.lastSuccessAt).toLocaleString()}
          </p>
        )}
        {oneDrive?.sync?.failureMessage && (
          <p className="text-xs text-destructive">{oneDrive.sync.failureMessage}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            loading={oneDriveBusy}
            disabled={!oneDriveRemotePath}
            onClick={saveOneDriveConfig}
          >
            保存路径
          </Button>
          <Button loading={oneDriveBusy} onClick={connectOneDrive}>
            {oneDrive?.connected ? '重新连接' : '连接'}
          </Button>
          {oneDrive?.connected && (
            <Button variant="softDestructive" loading={oneDriveBusy} onClick={disconnectOneDrive}>
              断开连接
            </Button>
          )}
        </div>
        {oneDrive?.connected && (
          <Card className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="break-all text-xs text-muted-foreground">/{oneDriveFolder}</p>
              <div className="flex items-center gap-1">
                {oneDriveFolder && (
                  <Button size="xs" variant="outline" onClick={goUpOneDriveFolder}>
                    Up
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="iconSm"
                  loading={oneDriveBusy}
                  onClick={() =>
                    loadOneDriveFolder(oneDriveFolder).catch((e) => setError(describeError(e)))
                  }
                >
                  <IconRefresh className="size-4" />
                </Button>
              </div>
            </div>
            {oneDriveItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">No folders or .kdbx files here.</p>
            ) : (
              <div className="grid gap-1">
                {oneDriveItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-2">
                    {item.isFolder ? (
                      <IconFolder className="size-4 shrink-0 text-amber-500" />
                    ) : (
                      <IconFile className="size-4 shrink-0 text-primary" />
                    )}
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded px-1 py-0.5 text-left hover:bg-secondary"
                      onClick={() =>
                        item.isFolder
                          ? loadOneDriveFolder(item.path).catch((e) => setError(describeError(e)))
                          : selectOneDriveVault(item)
                      }
                    >
                      <p className="max-w-[220px] truncate text-sm">{item.name}</p>
                      {!item.isFolder && item.lastModified && (
                        <p className="text-xs text-muted-foreground">
                          {new Date(item.lastModified).toLocaleDateString()}
                        </p>
                      )}
                    </button>
                    {!item.isFolder && (
                      <Button size="xs" variant="soft" onClick={() => selectOneDriveVault(item)}>
                        Use
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="soft"
            loading={oneDriveBusy}
            disabled={!oneDrive?.connected || !oneDriveRemotePath}
            onClick={() => oneDriveAction('onedrive.pull')}
          >
            <IconDownload className="size-4" />
            拉取
          </Button>
          <Button
            variant="soft"
            loading={oneDriveBusy}
            disabled={!oneDrive?.connected || !oneDriveRemotePath}
            onClick={() => oneDriveAction('onedrive.push')}
          >
            <IconUpload className="size-4" />
            推送
          </Button>
          <Button
            loading={oneDriveBusy}
            disabled={!oneDrive?.connected || !oneDriveRemotePath}
            onClick={() => oneDriveAction('onedrive.sync')}
          >
            <IconRefresh className="size-4" />
            同步
          </Button>
        </div>
      </div>
    </div>
  );
}

function PendingBanner({
  status,
  busy,
  onApply,
  onDismiss,
}: {
  status: VaultStatus;
  busy: boolean;
  onApply: (entryId?: string) => void;
  onDismiss: () => void;
}) {
  const pending = status.pending;
  if (!pending) return null;

  const isSave = pending.action === 'save';
  const title = isSave ? '保存凭据？' : '更新已保存的密码？';
  const account = pending.username || '(无用户名)';
  const description = isSave
    ? `将 ${pending.origin} 上的 ${account} 保存到 Monica KeePass。`
    : `替换 ${pending.origin} 上 "${pending.entryTitle || account}" 的密码。`;

  return (
    <Alert variant="info" className="mb-4">
      <div className="flex items-start gap-2">
        <IconKey className="mt-0.5 size-4 shrink-0" />
        <div className="grid gap-2">
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
          {!status.unlocked && (
            <p className="text-xs text-muted-foreground">解锁密码库后才能保存。</p>
          )}
          <div className="flex gap-2">
            <Button size="xs" disabled={busy || !status.unlocked} onClick={() => onApply()}>
              {isSave ? '保存' : '更新'}
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </Alert>
  );
}

function BackupView({
  status,
  onBack,
  onAfterImport,
  setError,
}: {
  status: VaultStatus;
  onBack: () => void;
  onAfterImport: () => Promise<void>;
  setError: (e: string) => void;
}) {
  const [direction, setDirection] = useState<'export' | 'import'>('export');
  const [destination, setDestination] = useState<'local' | 'onedrive'>('local');
  const [password, setPassword] = useState('');
  const [keyFileB64, setKeyFileB64] = useState<string | null>(null);
  const [importFileB64, setImportFileB64] = useState<string | null>(null);
  const [oneDrivePath, setOneDrivePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmImport, setConfirmImport] = useState(false);

  useEffect(() => {
    setConfirmImport(false);
    setMessage('');
  }, [direction, destination]);

  const pickKeyFile = async (file: File | null) => {
    if (!file) {
      setKeyFileB64(null);
      return;
    }
    setKeyFileB64(bytesToBase64(await file.arrayBuffer()));
  };

  const pickImportFile = async (file: File | null) => {
    if (!file) {
      setImportFileB64(null);
      return;
    }
    setImportFileB64(bytesToBase64(await file.arrayBuffer()));
  };

  const triggerDownload = (b64: string, filename: string) => {
    const bytes = base64ToBytes(b64);
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const credentialPayload = () => ({
    ...(password ? { password } : {}),
    ...(keyFileB64 ? { keyFileB64 } : {}),
  });

  const hasCred = Boolean(password || keyFileB64);
  const cannotExport = !status.hasVault;

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      setMessage(await fn());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const exportLocal = () =>
    run(async () => {
      const result = await callBackground({
        type: 'backup.exportLocal',
        credential: credentialPayload(),
      });
      triggerDownload(result.data, result.suggestedName);
      return `已下载 ${result.suggestedName}。`;
    });

  const exportOneDrive = () =>
    run(async () => {
      const result = await callBackground({
        type: 'backup.exportToOneDrive',
        credential: credentialPayload(),
        ...(oneDrivePath.trim() ? { path: oneDrivePath.trim() } : {}),
      });
      return `${result.message} → ${result.path}`;
    });

  const importLocal = () =>
    run(async () => {
      if (!importFileB64) throw new Error('请先选择备份文件');
      await callBackground({
        type: 'backup.importLocal',
        data: importFileB64,
        credential: credentialPayload(),
      });
      await onAfterImport();
      return '备份已恢复。如需继续使用 Windows Hello 或 OneDrive，请重新启用/连接。';
    });

  const importOneDrive = () =>
    run(async () => {
      if (!oneDrivePath.trim()) throw new Error('请输入 OneDrive 备份文件路径');
      await callBackground({
        type: 'backup.importFromOneDrive',
        path: oneDrivePath.trim(),
        credential: credentialPayload(),
      });
      await onAfterImport();
      return '已从 OneDrive 恢复备份。如需继续使用 Windows Hello 或 OneDrive，请重新启用/连接。';
    });

  return (
    <div className="grid gap-3">
      <BackLink label="返回设置" onClick={onBack} />
      <h2 className="text-lg font-medium">备份与恢复</h2>

      <p className="text-xs text-muted-foreground">
        密码库、已记住的密钥文件和 OneDrive 配置会打包成一个加密的
        .mkbackup 文件。Windows Hello 注册信息和 OneDrive token 不会离开此设备。
      </p>

      <Tabs value={direction} onValueChange={(v) => setDirection(v as 'export' | 'import')}>
        <TabsList>
          <TabsTrigger value="export">导出</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
        </TabsList>
      </Tabs>

      <Tabs value={destination} onValueChange={(v) => setDestination(v as 'local' | 'onedrive')}>
        <TabsList>
          <TabsTrigger value="local">本地文件</TabsTrigger>
          <TabsTrigger value="onedrive">OneDrive</TabsTrigger>
        </TabsList>
      </Tabs>

      <Field
        label="备份密码"
        description="用于加密备份包，独立于密码库主密码。"
      >
        <PasswordInput value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
      </Field>
      <FileField label="Key file (optional)" onFile={pickKeyFile} />

      {direction === 'import' && destination === 'local' && (
        <FileField
          label="备份文件"
          accept=".mkbackup,application/octet-stream"
          onFile={pickImportFile}
        />
      )}

      {destination === 'onedrive' && (
        <Field
          label={direction === 'export' ? 'OneDrive 路径（可选）' : 'OneDrive 备份文件路径'}
          description={
            direction === 'export'
              ? '默认保存到密码库所在文件夹，并使用带时间戳的文件名。'
              : undefined
          }
        >
          <Input
            placeholder="/Apps/MonicaKeePass/monica-keepass-backup-….mkbackup"
            value={oneDrivePath}
            onChange={(e) => setOneDrivePath(e.currentTarget.value)}
          />
        </Field>
      )}

      {direction === 'import' && (
        <Alert variant="warning">
          <AlertTitle>这会替换此设备上的全部扩展数据</AlertTitle>
          <AlertDescription>
            <p className="mb-2 text-xs">
              当前密码库、已记住的密钥文件和 OneDrive 设置会被备份内容覆盖。
              此设备上的 Windows Hello 注册信息和 OneDrive 会话也会被清除。
            </p>
            <CheckboxField
              label="我已了解，继续"
              checked={confirmImport}
              onCheckedChange={setConfirmImport}
            />
          </AlertDescription>
        </Alert>
      )}

      {direction === 'export' && cannotExport && (
        <Alert variant="warning">
          <AlertDescription>请先导入或创建密码库，再导出备份。</AlertDescription>
        </Alert>
      )}

      {message && (
        <Alert variant="success">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        {direction === 'export' && destination === 'local' && (
          <Button loading={busy} disabled={!hasCred || cannotExport} onClick={exportLocal}>
            <IconDownload className="size-4" />
            下载备份
          </Button>
        )}
        {direction === 'export' && destination === 'onedrive' && (
          <Button loading={busy} disabled={!hasCred || cannotExport} onClick={exportOneDrive}>
            <IconCloud className="size-4" />
            上传到 OneDrive
          </Button>
        )}
        {direction === 'import' && destination === 'local' && (
          <Button
            variant="destructive"
            loading={busy}
            disabled={!hasCred || !importFileB64 || !confirmImport}
            onClick={importLocal}
          >
            从文件恢复
          </Button>
        )}
        {direction === 'import' && destination === 'onedrive' && (
          <Button
            variant="destructive"
            loading={busy}
            disabled={!hasCred || !oneDrivePath.trim() || !confirmImport}
            onClick={importOneDrive}
          >
            从 OneDrive 恢复
          </Button>
        )}
      </div>
    </div>
  );
}
