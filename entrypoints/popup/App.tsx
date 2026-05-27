import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Divider,
  FileInput,
  Group,
  Loader,
  PasswordInput,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
  ActionIcon,
  CopyButton,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconCheck,
  IconCloud,
  IconCopy,
  IconDownload,
  IconEye,
  IconFile,
  IconFingerprint,
  IconFolder,
  IconKey,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
  IconUpload,
  IconWand,
} from '@tabler/icons-react';
import {
  bytesToBase64,
  callBackground,
  type CredentialInput,
  type OneDriveStatus,
  type VaultStatus,
} from '@/src/messaging/protocol';
import { DEFAULT_ONEDRIVE_CLIENT_ID, type OneDriveListItem } from '@/src/onedrive/graph';
import type { EntryDetail, EntrySummary, NewEntryInput } from '@/src/vault/types';
import { clearHello, enrollHello, isHelloAvailable, unlockWithHello } from '@/src/hello/webauthn';
import { Generator } from './Generator';

type View = 'loading' | 'setup' | 'locked' | 'list' | 'detail' | 'form' | 'generator' | 'settings';

function describeError(e: unknown): string {
  if (e instanceof DOMException) return `${e.name}: ${e.message || 'WebAuthn request failed'}`;
  if (e instanceof Error) return e.message;
  return String(e);
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
    <Box style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <Group
        justify="space-between"
        px="md"
        py="xs"
        style={{ borderBottom: '1px solid var(--mantine-color-gray-3)' }}
      >
        <Group gap={8}>
          <img src="/icons/icon-32.png" alt="" width={24} height={24} />
          <Title order={5} fw={650}>
            Monica KeePass
          </Title>
        </Group>
        {status?.unlocked && (
          <Group gap={2}>
            <Tooltip label="Password generator">
              <ActionIcon variant="subtle" color="gray" onClick={() => setView('generator')}>
                <IconWand size={20} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Settings">
              <ActionIcon variant="subtle" color="gray" onClick={() => setView('settings')}>
                <IconSettings size={20} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Lock vault">
              <ActionIcon variant="subtle" color="gray" onClick={lock}>
                <IconLock size={20} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>

      <ScrollArea style={{ flex: 1 }}>
        <Box p="md">
          {error && (
            <Alert color="red" mb="md" variant="light" onClose={() => setError('')} withCloseButton>
              {error}
            </Alert>
          )}

          {view === 'loading' && (
            <Center mih={300}>
              <Loader />
            </Center>
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
            />
          )}

          {view === 'locked' && status && (
            <LockedView
              busy={busy}
              status={status}
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
            <Stack>
              <Generator />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setView(status?.unlocked ? 'list' : 'locked')}>
                  Done
                </Button>
              </Group>
            </Stack>
          )}

          {view === 'settings' && status && (
            <SettingsView
              status={status}
              credential={credential}
              onChanged={refreshStatus}
              onBack={() => setView('list')}
              setError={setError}
            />
          )}
        </Box>
      </ScrollArea>
    </Box>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Anchor component="button" type="button" size="sm" onClick={onClick} mb="sm">
      <Group gap={4}>
        <IconArrowLeft size={14} />
        {label}
      </Group>
    </Anchor>
  );
}

function SetupView({
  busy,
  canGoBack,
  onBack,
  onCreate,
  onImport,
}: {
  busy: boolean;
  canGoBack: boolean;
  onBack: () => void;
  onCreate: (name: string, password: string) => void;
  onImport: (name: string, dataB64: string) => void;
}) {
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [name, setName] = useState('My Vault');
  const [password, setPassword] = useState('');

  const handleFile = async (file: File | null) => {
    if (!file) return;
    onImport(file.name, bytesToBase64(await file.arrayBuffer()));
  };

  return (
    <Stack>
      {canGoBack && <BackLink label="Back to unlock" onClick={onBack} />}
      <SegmentedControl
        fullWidth
        value={mode}
        onChange={(v) => setMode(v as 'create' | 'import')}
        data={[
          { label: 'Create', value: 'create' },
          { label: 'Import .kdbx', value: 'import' },
        ]}
      />

      {mode === 'create' ? (
        <>
          <TextInput label="Vault name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <PasswordInput
            label="Master password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <Button disabled={busy || !password || !name} onClick={() => onCreate(name, password)}>
            Create vault
          </Button>
        </>
      ) : (
        <>
          <Text size="sm" c="dimmed">
            Select an existing KeePass .kdbx file to manage in this browser.
          </Text>
          <FileInput
            accept=".kdbx"
            placeholder="Choose .kdbx file"
            leftSection={<IconKey size={16} />}
            onChange={handleFile}
          />
        </>
      )}
    </Stack>
  );
}

function LockedView({
  busy,
  status,
  onSwitchVault,
  onUnlock,
  onHello,
}: {
  busy: boolean;
  status: VaultStatus;
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

  return (
    <Stack>
      <PasswordInput
        label="Master password"
        description="Leave empty for a key-file-only vault"
        data-autofocus
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && canUnlock && submit()}
      />

      {status.rememberedKeyFile && !keyFileB64 ? (
        <Text size="sm" c="dimmed">
          Using remembered key file on this device.
        </Text>
      ) : (
        <FileInput
          label="Key file (optional)"
          placeholder="Choose key file"
          leftSection={<IconKey size={16} />}
          clearable
          onChange={pickKeyFile}
        />
      )}
      {keyFileB64 && (
        <Checkbox
          label="Remember key file on this device"
          checked={remember}
          onChange={(e) => setRemember(e.currentTarget.checked)}
        />
      )}

      <Button disabled={busy || !canUnlock} onClick={submit}>
        Unlock
      </Button>
      {status.helloEnrolled && (
        <Button
          variant="default"
          leftSection={<IconFingerprint size={18} />}
          disabled={busy}
          onClick={onHello}
        >
          Unlock with Windows Hello
        </Button>
      )}
      <Anchor component="button" type="button" size="sm" c="dimmed" onClick={onSwitchVault}>
        Use a different vault…
      </Anchor>
    </Stack>
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
    <Stack gap="sm">
      <Group gap="xs" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Tooltip label="Add entry">
          <ActionIcon size="lg" onClick={onAdd}>
            <IconPlus size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {filtered.length === 0 ? (
        <Text c="dimmed" size="sm" ta="center" mt="lg">
          No entries.
        </Text>
      ) : (
        <Stack gap={8}>
          {filtered.map((e) => (
            <UnstyledButton key={e.id} onClick={() => onOpen(e.id)} style={{ width: '100%' }}>
              <Card withBorder padding="sm" radius="md">
                <Text fw={600} size="sm">
                  {e.title || '(untitled)'}
                </Text>
                <Text size="xs" c="dimmed">
                  {e.username || e.url}
                </Text>
              </Card>
            </UnstyledButton>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Group gap="xs" wrap="nowrap" align="center">
        <Text size="sm" style={{ flex: 1, wordBreak: 'break-all' }}>
          {value}
        </Text>
        <CopyButton value={value}>
          {({ copied, copy }) => (
            <ActionIcon variant="subtle" color="gray" onClick={copy}>
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          )}
        </CopyButton>
      </Group>
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
    <Stack gap="sm">
      <BackLink label="Back" onClick={onBack} />
      <Title order={4}>{entry.title || '(untitled)'}</Title>

      <CopyRow label="Username" value={entry.username} />

      <div>
        <Text size="xs" c="dimmed">
          Password
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" ff="monospace" style={{ flex: 1, wordBreak: 'break-all' }}>
            {entry.password ?? '••••••••'}
          </Text>
          {entry.password ? (
            <CopyButton value={entry.password}>
              {({ copied, copy }) => (
                <ActionIcon variant="subtle" color="gray" onClick={copy}>
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </ActionIcon>
              )}
            </CopyButton>
          ) : (
            <Tooltip label="Reveal">
              <ActionIcon variant="subtle" color="gray" onClick={onReveal}>
                <IconEye size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </div>

      <CopyRow label="URL" value={entry.url} />
      <CopyRow label="Notes" value={entry.notes} />

      <Group mt="md">
        <Button onClick={onEdit}>Edit</Button>
        <Button variant="light" color="red" leftSection={<IconTrash size={16} />} onClick={onDelete}>
          Delete
        </Button>
      </Group>
    </Stack>
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
    <Stack gap="sm">
      <BackLink label="Cancel" onClick={onCancel} />
      <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
      <TextInput label="Username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
      <TextInput
        label="Password"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        rightSection={
          <Tooltip label="Generate">
            <ActionIcon variant="subtle" color="gray" onClick={() => setShowGen((v) => !v)}>
              <IconWand size={16} />
            </ActionIcon>
          </Tooltip>
        }
      />
      {showGen && (
        <Card withBorder padding="sm" radius="md">
          <Generator
            onUse={(pw) => {
              setPassword(pw);
              setShowGen(false);
            }}
          />
        </Card>
      )}
      <TextInput label="URL" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
      <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} autosize minRows={2} />
      <Group justify="flex-end">
        <Button disabled={busy} onClick={() => onSave({ title, username, password, url, notes })}>
          Save
        </Button>
      </Group>
    </Stack>
  );
}

function SettingsView({
  status,
  credential,
  onChanged,
  onBack,
  setError,
}: {
  status: VaultStatus;
  credential: CredentialInput | null;
  onChanged: () => Promise<VaultStatus>;
  onBack: () => void;
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

  useEffect(() => {
    isHelloAvailable().then(setAvailable);
  }, []);

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
      return `${item.name} selected. ${result.message}`;
    });

  const goUpOneDriveFolder = () => {
    const parent = oneDriveFolder.split('/').slice(0, -1).join('/');
    runOneDrive(async () => {
      await loadOneDriveFolder(parent);
      return '';
    });
  };

  return (
    <Stack gap="sm">
      <BackLink label="Back" onClick={onBack} />
      <Title order={4}>Settings</Title>

      <div>
        <Text size="xs" c="dimmed">
          Vault
        </Text>
        <Text size="sm">
          {status.meta?.name} · {status.meta?.entryCount} entries
        </Text>
      </div>

      <Divider />

      <div>
        <Text size="sm" fw={600} mb={6}>
          Windows Hello
        </Text>
        {available === false && (
          <Text size="xs" c="dimmed" mb={6}>
            No platform authenticator available on this device.
          </Text>
        )}
        {status.helloEnrolled ? (
          <Button variant="light" color="red" loading={helloBusy} onClick={disable}>
            Disable Windows Hello
          </Button>
        ) : (
          <Button
            leftSection={<IconFingerprint size={18} />}
            disabled={available !== true || !credential}
            loading={helloBusy}
            onClick={enable}
          >
            Enable Windows Hello
          </Button>
        )}
      </div>

      {status.rememberedKeyFile && (
        <>
          <Divider />
          <div>
            <Text size="sm" fw={600} mb={6}>
              Key file
            </Text>
            <Button variant="light" color="red" onClick={forgetKeyFile}>
              Forget remembered key file
            </Button>
          </div>
        </>
      )}

      <Divider />

      <div>
        <Group gap={6} mb={6}>
          <IconCloud size={18} />
          <Text size="sm" fw={600}>
            OneDrive
          </Text>
        </Group>
        {oneDriveMessage && (
          <Alert color="green" mb="sm" variant="light">
            {oneDriveMessage}
          </Alert>
        )}
        <Stack gap="xs">
          <TextInput
            label="Selected OneDrive vault"
            placeholder="Connect and choose a .kdbx file"
            value={oneDriveRemotePath}
            onChange={(e) => setOneDriveRemotePath(e.currentTarget.value)}
          />
          {oneDrive?.redirectUrl && (
            <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
              Redirect URI: {oneDrive.redirectUrl}
            </Text>
          )}
          {oneDrive?.sync?.lastSuccessAt && (
            <Text size="xs" c="dimmed">
              Last synced {new Date(oneDrive.sync.lastSuccessAt).toLocaleString()}
            </Text>
          )}
          {oneDrive?.sync?.failureMessage && (
            <Text size="xs" c="red">
              {oneDrive.sync.failureMessage}
            </Text>
          )}
          <Group gap="xs">
            <Button
              variant="default"
              loading={oneDriveBusy}
              disabled={!oneDriveRemotePath}
              onClick={saveOneDriveConfig}
            >
              Save path
            </Button>
            <Button
              loading={oneDriveBusy}
              onClick={connectOneDrive}
            >
              {oneDrive?.connected ? 'Reconnect' : 'Connect'}
            </Button>
            {oneDrive?.connected && (
              <Button variant="light" color="red" loading={oneDriveBusy} onClick={disconnectOneDrive}>
                Disconnect
              </Button>
            )}
          </Group>
          {oneDrive?.connected && (
            <Card withBorder padding="sm" radius="md">
              <Stack gap="xs">
                <Group justify="space-between" wrap="nowrap">
                  <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                    /{oneDriveFolder}
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    {oneDriveFolder && (
                      <Button size="compact-xs" variant="default" onClick={goUpOneDriveFolder}>
                        Up
                      </Button>
                    )}
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      loading={oneDriveBusy}
                      onClick={() => loadOneDriveFolder(oneDriveFolder).catch((e) => setError(describeError(e)))}
                    >
                      <IconRefresh size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
                {oneDriveItems.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    No folders or .kdbx files here.
                  </Text>
                ) : (
                  <Stack gap={4}>
                    {oneDriveItems.map((item) => (
                      <Group key={item.id} gap="xs" wrap="nowrap">
                        <ActionIcon variant="subtle" color={item.isFolder ? 'yellow' : 'blue'}>
                          {item.isFolder ? <IconFolder size={16} /> : <IconFile size={16} />}
                        </ActionIcon>
                        <UnstyledButton
                          style={{ flex: 1, minWidth: 0 }}
                          onClick={() =>
                            item.isFolder
                              ? loadOneDriveFolder(item.path).catch((e) => setError(describeError(e)))
                              : selectOneDriveVault(item)
                          }
                        >
                          <Text size="sm" truncate>
                            {item.name}
                          </Text>
                          {!item.isFolder && item.lastModified && (
                            <Text size="xs" c="dimmed">
                              {new Date(item.lastModified).toLocaleDateString()}
                            </Text>
                          )}
                        </UnstyledButton>
                        {!item.isFolder && (
                          <Button size="compact-xs" variant="light" onClick={() => selectOneDriveVault(item)}>
                            Use
                          </Button>
                        )}
                      </Group>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Card>
          )}
          <Group gap="xs">
            <Button
              variant="light"
              leftSection={<IconDownload size={16} />}
              loading={oneDriveBusy}
              disabled={!oneDrive?.connected || !oneDriveRemotePath}
              onClick={() => oneDriveAction('onedrive.pull')}
            >
              Pull
            </Button>
            <Button
              variant="light"
              leftSection={<IconUpload size={16} />}
              loading={oneDriveBusy}
              disabled={!oneDrive?.connected || !oneDriveRemotePath}
              onClick={() => oneDriveAction('onedrive.push')}
            >
              Push
            </Button>
            <Button
              leftSection={<IconRefresh size={16} />}
              loading={oneDriveBusy}
              disabled={!oneDrive?.connected || !oneDriveRemotePath}
              onClick={() => oneDriveAction('onedrive.sync')}
            >
              Sync
            </Button>
          </Group>
        </Stack>
      </div>
    </Stack>
  );
}
