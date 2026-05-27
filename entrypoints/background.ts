import {
  type BgRequest,
  type CredentialInput,
  type OffscreenOp,
  type OneDriveStatus,
  type OneDriveSyncResult,
  type OneDriveSyncState,
  type VaultStatus,
} from '@/src/messaging/protocol';
import { matchEntriesForUrl } from '@/src/autofill/match';
import type { EntrySummary, VaultMeta } from '@/src/vault/types';
import {
  conflictPath,
  DEFAULT_ONEDRIVE_CLIENT_ID,
  fileNameFromPath,
  getRedirectUrl,
  listRemoteDirectory,
  normalizeRemotePath,
  readRemote,
  refreshAuth,
  sha256Hex,
  startAuth,
  statRemote,
  writeRemote,
  type OneDriveConfig,
  type OneDriveFileStat,
  type OneDriveToken,
} from '@/src/onedrive/graph';

const FILE_KEY = 'vault.file';
const KEYFILE_KEY = 'vault.keyfile';
const HELLO_KEY = 'hello.enrollment';
const ONEDRIVE_CONFIG_KEY = 'onedrive.config';
const ONEDRIVE_TOKEN_KEY = 'onedrive.token';
const ONEDRIVE_SYNC_KEY = 'onedrive.sync';
const AUTO_LOCK_ALARM = 'autolock';
const AUTO_LOCK_MINUTES = 15;

interface StoredFile {
  name: string;
  data: string; // base64 of the .kdbx bytes
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: BgRequest, _sender, sendResponse) => {
    // Offscreen-targeted envelopes are handled in the offscreen document.
    if ((msg as { target?: string }).target === 'offscreen') return undefined;
    route(msg).then(
      (value) => sendResponse({ ok: true, value }),
      (err: unknown) => sendResponse({ ok: false, error: errorMessage(err) }),
    );
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) {
      callOffscreen({ op: 'lock' }).catch(() => {});
    }
  });
});

async function route(req: BgRequest): Promise<unknown> {
  switch (req.type) {
    case 'vault.status':
      return getStatus();

    case 'vault.import':
      // Switching vaults: drop any open vault and credentials tied to the old one.
      await callOffscreen({ op: 'lock' }).catch(() => {});
      await chrome.storage.local.set({
        [FILE_KEY]: { name: req.name ?? 'vault.kdbx', data: req.data } satisfies StoredFile,
      });
      await chrome.storage.local.remove([KEYFILE_KEY, HELLO_KEY]);
      return getStatus();

    case 'vault.createNew': {
      const data = (await callOffscreen({
        op: 'createNew',
        name: req.name,
        password: req.password,
      })) as string;
      await chrome.storage.local.set({
        [FILE_KEY]: { name: `${req.name}.kdbx`, data } satisfies StoredFile,
      });
      await chrome.storage.local.remove([KEYFILE_KEY, HELLO_KEY]);
      armAutoLock();
      return getStatus();
    }

    case 'vault.unlock': {
      const file = await loadFile();
      if (!file) throw new Error('No vault has been imported yet');
      const keyFile = req.credential.keyFile ?? (await loadRememberedKeyFile()) ?? undefined;
      await callOffscreen({
        op: 'open',
        data: file.data,
        password: req.credential.password,
        keyFile,
      });
      if (req.rememberKeyFile && req.credential.keyFile) {
        await chrome.storage.local.set({ [KEYFILE_KEY]: req.credential.keyFile });
      }
      armAutoLock();
      return getStatus();
    }

    case 'vault.lock':
      await callOffscreen({ op: 'lock' });
      chrome.alarms.clear(AUTO_LOCK_ALARM);
      return getStatus();

    case 'vault.forgetKeyFile':
      await chrome.storage.local.remove(KEYFILE_KEY);
      return getStatus();

    case 'vault.listEntries':
      armAutoLock();
      return callOffscreen({ op: 'listEntries' });

    case 'vault.listGroups':
      armAutoLock();
      return callOffscreen({ op: 'listGroups' });

    case 'vault.getEntry':
      armAutoLock();
      return callOffscreen({ op: 'getEntry', id: req.id, reveal: req.reveal });

    case 'vault.add': {
      const summary = await callOffscreen({ op: 'add', input: req.input });
      await persist();
      armAutoLock();
      return summary;
    }

    case 'vault.update': {
      const summary = await callOffscreen({ op: 'update', input: req.input });
      await persist();
      armAutoLock();
      return summary;
    }

    case 'vault.delete': {
      await callOffscreen({ op: 'delete', id: req.id });
      await persist();
      armAutoLock();
      return null;
    }

    case 'vault.match': {
      armAutoLock();
      const entries = (await callOffscreen({ op: 'listEntries' })) as EntrySummary[];
      return matchEntriesForUrl(entries, req.url);
    }

    case 'vault.export':
      return callOffscreen({ op: 'save' });

    case 'onedrive.status':
      return getOneDriveStatus();

    case 'onedrive.configure':
      return configureOneDrive(req.clientId, req.remotePath);

    case 'onedrive.connect':
      return connectOneDrive();

    case 'onedrive.disconnect':
      await chrome.storage.local.remove([ONEDRIVE_TOKEN_KEY, ONEDRIVE_SYNC_KEY]);
      return getOneDriveStatus();

    case 'onedrive.list':
      return listOneDrive(req.path);

    case 'onedrive.pull':
      return pullOneDrive();

    case 'onedrive.push':
      return pushOneDrive();

    case 'onedrive.sync':
      return syncOneDrive(req.credential ?? null);
  }
}

async function persist(): Promise<void> {
  const data = (await callOffscreen({ op: 'save' })) as string;
  const file = await loadFile();
  await chrome.storage.local.set({
    [FILE_KEY]: { name: file?.name ?? 'vault.kdbx', data } satisfies StoredFile,
  });
}

async function getStatus(): Promise<VaultStatus> {
  const file = await loadFile();
  const helloEnrolled = (await chrome.storage.local.get(HELLO_KEY))[HELLO_KEY] != null;
  const rememberedKeyFile = (await loadRememberedKeyFile()) != null;
  let unlocked = false;
  let meta: VaultMeta | null = null;
  if (await hasOffscreen()) {
    const status = (await callOffscreen({ op: 'status' })) as { unlocked: boolean };
    unlocked = status.unlocked;
    if (unlocked) meta = (await callOffscreen({ op: 'meta' })) as VaultMeta;
  }
  return { unlocked, hasVault: file != null, helloEnrolled, rememberedKeyFile, meta };
}

async function loadFile(): Promise<StoredFile | null> {
  const stored = await chrome.storage.local.get(FILE_KEY);
  return (stored[FILE_KEY] as StoredFile | undefined) ?? null;
}

async function loadRememberedKeyFile(): Promise<string | null> {
  const stored = await chrome.storage.local.get(KEYFILE_KEY);
  return (stored[KEYFILE_KEY] as string | undefined) ?? null;
}

async function configureOneDrive(clientId: string, remotePath: string): Promise<OneDriveStatus> {
  const config = {
    clientId: clientId.trim() || DEFAULT_ONEDRIVE_CLIENT_ID,
    remotePath: normalizeRemotePath(remotePath),
  };
  if (!config.clientId) throw new Error('OneDrive Microsoft client ID is required');
  await chrome.storage.local.set({ [ONEDRIVE_CONFIG_KEY]: config satisfies OneDriveConfig });
  await chrome.storage.local.remove(ONEDRIVE_SYNC_KEY);
  return getOneDriveStatus();
}

async function connectOneDrive(): Promise<OneDriveSyncResult> {
  const config = await loadOneDriveClientConfig();
  const token = await startAuth(config.clientId);
  await chrome.storage.local.set({ [ONEDRIVE_TOKEN_KEY]: token });
  return {
    action: 'connected',
    message: 'OneDrive connected.',
    stat: config.remotePath ? await statRemote(token.accessToken, config.remotePath) : null,
  };
}

async function getOneDriveStatus(): Promise<OneDriveStatus> {
  const [config, token, sync] = await Promise.all([
    loadOneDriveClientConfig(),
    loadOneDriveToken(),
    loadOneDriveSyncState(),
  ]);
  return {
    configured: true,
    connected: token != null,
    redirectUrl: getRedirectUrl(),
    config,
    sync,
  };
}

async function pullOneDrive(): Promise<OneDriveSyncResult> {
  const config = await loadOneDriveVaultConfig();
  const token = await getOneDriveAccessToken(config);
  await updateOneDrivePhase({ syncPhase: 'DOWNLOADING' });
  try {
    const [remoteData, stat] = await Promise.all([
      readRemote(token, config.remotePath),
      statRemote(token, config.remotePath),
    ]);
    if (!stat) throw new Error('OneDrive remote vault does not exist');
    await callOffscreen({ op: 'lock' }).catch(() => {});
    await chrome.storage.local.set({
      [FILE_KEY]: { name: fileNameFromPath(config.remotePath), data: remoteData } satisfies StoredFile,
    });
    await rememberOneDriveSuccess(remoteData, stat);
    return { action: 'pulled', message: 'Downloaded the OneDrive vault into this browser.', stat };
  } catch (e) {
    await rememberOneDriveFailure(e);
    throw e;
  }
}

async function pushOneDrive(): Promise<OneDriveSyncResult> {
  const config = await loadOneDriveVaultConfig();
  const token = await getOneDriveAccessToken(config);
  await updateOneDrivePhase({ syncPhase: 'UPLOADING' });
  try {
    const localData = await currentVaultData();
    const sync = await loadOneDriveSyncState();
    const stat = await writeRemote(token, config.remotePath, localData, sync?.remoteVersionToken);
    await storeVaultFile(localData, fileNameFromPath(config.remotePath));
    await rememberOneDriveSuccess(localData, stat);
    return { action: 'pushed', message: 'Uploaded the local vault to OneDrive.', stat };
  } catch (e) {
    await rememberOneDriveFailure(e);
    throw e;
  }
}

async function syncOneDrive(credential: CredentialInput | null): Promise<OneDriveSyncResult> {
  const config = await loadOneDriveVaultConfig();
  const token = await getOneDriveAccessToken(config);
  await updateOneDrivePhase({ syncPhase: 'COMPARING' });
  try {
    const localData = await currentVaultData();
    const localHash = await sha256Hex(localData);
    const sync = await loadOneDriveSyncState();
    const remoteStat = await statRemote(token, config.remotePath);
    if (!remoteStat) {
      await updateOneDrivePhase({ syncPhase: 'UPLOADING' });
      const created = await writeRemote(token, config.remotePath, localData, null);
      await rememberOneDriveSuccess(localData, created);
      return { action: 'pushed', message: 'OneDrive file did not exist, so the local vault was uploaded.', stat: created };
    }

    const localChanged = sync?.workingHash ? localHash !== sync.workingHash : false;
    const remoteChanged = sync?.remoteVersionToken
      ? remoteStat.versionToken !== sync.remoteVersionToken
      : false;

    if (!sync?.remoteVersionToken) {
      const remoteData = await readRemote(token, config.remotePath);
      if (localHash === (await sha256Hex(remoteData))) {
        await rememberOneDriveSuccess(localData, remoteStat);
        return { action: 'synced', message: 'Local and OneDrive vaults are already the same.', stat: remoteStat };
      }
      if (!credential) {
        return createConflictCopy(token, config, localData, remoteStat);
      }
      const mergedData = (await callOffscreen({
        op: 'mergeRemote',
        data: remoteData,
        password: credential.password,
        keyFile: credential.keyFile,
      })) as string;
      await storeVaultFile(mergedData, fileNameFromPath(config.remotePath));
      const uploaded = await writeRemote(token, config.remotePath, mergedData, remoteStat.versionToken);
      await rememberOneDriveSuccess(mergedData, uploaded);
      return { action: 'merged', message: 'Linked this browser to the existing OneDrive vault and uploaded the merged result.', stat: uploaded };
    }

    if (!remoteChanged) {
      if (!localChanged && sync?.remoteVersionToken) {
        await rememberOneDriveSuccess(localData, remoteStat);
        return { action: 'synced', message: 'Vault is already in sync.', stat: remoteStat };
      }
      await updateOneDrivePhase({ syncPhase: 'UPLOADING' });
      const uploaded = await writeRemote(token, config.remotePath, localData, remoteStat.versionToken);
      await storeVaultFile(localData, fileNameFromPath(config.remotePath));
      await rememberOneDriveSuccess(localData, uploaded);
      return { action: 'pushed', message: 'Uploaded local changes to OneDrive.', stat: uploaded };
    }

    await updateOneDrivePhase({ syncPhase: localChanged ? 'MERGING' : 'DOWNLOADING' });
    const remoteData = await readRemote(token, config.remotePath);
    if (!localChanged) {
      await callOffscreen({ op: 'lock' }).catch(() => {});
      await storeVaultFile(remoteData, fileNameFromPath(config.remotePath));
      await rememberOneDriveSuccess(remoteData, remoteStat);
      return { action: 'pulled', message: 'Downloaded newer OneDrive changes.', stat: remoteStat };
    }

    if (!credential) {
      return createConflictCopy(token, config, localData, remoteStat);
    }

    const mergedData = (await callOffscreen({
      op: 'mergeRemote',
      data: remoteData,
      password: credential.password,
      keyFile: credential.keyFile,
    })) as string;
    await storeVaultFile(mergedData, fileNameFromPath(config.remotePath));
    const uploaded = await writeRemote(token, config.remotePath, mergedData, remoteStat.versionToken);
    await rememberOneDriveSuccess(mergedData, uploaded);
    return { action: 'merged', message: 'Merged local and OneDrive changes, then uploaded the result.', stat: uploaded };
  } catch (e) {
    await rememberOneDriveFailure(e);
    throw e;
  }
}

async function createConflictCopy(
  token: string,
  config: OneDriveConfig,
  localData: string,
  remoteStat: OneDriveFileStat,
): Promise<OneDriveSyncResult> {
  const path = conflictPath(config.remotePath);
  const stat = await writeRemote(token, path, localData, null);
  await updateOneDrivePhase({
    syncPhase: 'CONFLICT',
    hasLocalChanges: true,
    hasRemoteChanges: true,
    remoteVersionToken: remoteStat.versionToken,
    remoteEtag: remoteStat.eTag,
    remoteLastModified: remoteStat.lastModified,
  });
  return {
    action: 'conflict',
    message: 'Both local and OneDrive changed. A local conflict copy was uploaded; unlock the vault and run sync again to merge.',
    stat,
    conflictPath: path,
  };
}

async function currentVaultData(): Promise<string> {
  if (await hasOffscreen()) {
    const status = (await callOffscreen({ op: 'status' })) as { unlocked: boolean };
    if (status.unlocked) return (await callOffscreen({ op: 'save' })) as string;
  }
  const file = await loadFile();
  if (!file) throw new Error('No local vault has been imported yet');
  return file.data;
}

async function listOneDrive(path: string) {
  const config = await loadOneDriveClientConfig();
  const token = await getOneDriveAccessToken(config);
  return listRemoteDirectory(token, path);
}

async function storeVaultFile(data: string, name: string): Promise<void> {
  await chrome.storage.local.set({
    [FILE_KEY]: { name, data } satisfies StoredFile,
  });
}

async function loadOneDriveClientConfig(): Promise<OneDriveConfig> {
  const config = await maybeLoadOneDriveConfig();
  return config ?? { clientId: DEFAULT_ONEDRIVE_CLIENT_ID, remotePath: '' };
}

async function loadOneDriveVaultConfig(): Promise<OneDriveConfig> {
  const config = await loadOneDriveClientConfig();
  if (!config.remotePath) throw new Error('Select a OneDrive .kdbx vault first');
  return config;
}

async function maybeLoadOneDriveConfig(): Promise<OneDriveConfig | null> {
  const stored = await chrome.storage.local.get(ONEDRIVE_CONFIG_KEY);
  const config = stored[ONEDRIVE_CONFIG_KEY] as OneDriveConfig | undefined;
  if (!config) return null;
  return {
    clientId: config.clientId || DEFAULT_ONEDRIVE_CLIENT_ID,
    remotePath: normalizeRemotePath(config.remotePath || ''),
  };
}

async function loadOneDriveToken(): Promise<OneDriveToken | null> {
  const stored = await chrome.storage.local.get(ONEDRIVE_TOKEN_KEY);
  return (stored[ONEDRIVE_TOKEN_KEY] as OneDriveToken | undefined) ?? null;
}

async function getOneDriveAccessToken(config: OneDriveConfig): Promise<string> {
  const token = await loadOneDriveToken();
  if (!token) throw new Error('Connect OneDrive first');
  if (Date.now() < token.expiresAt) return token.accessToken;
  if (!token.refreshToken) throw new Error('OneDrive session expired. Connect again.');
  const refreshed = await refreshAuth(config.clientId, token.refreshToken);
  await chrome.storage.local.set({
    [ONEDRIVE_TOKEN_KEY]: {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? token.refreshToken,
    } satisfies OneDriveToken,
  });
  return refreshed.accessToken;
}

async function loadOneDriveSyncState(): Promise<OneDriveSyncState | null> {
  const stored = await chrome.storage.local.get(ONEDRIVE_SYNC_KEY);
  return (stored[ONEDRIVE_SYNC_KEY] as OneDriveSyncState | undefined) ?? null;
}

async function updateOneDrivePhase(patch: OneDriveSyncState): Promise<void> {
  const previous = (await loadOneDriveSyncState()) ?? {};
  await chrome.storage.local.set({ [ONEDRIVE_SYNC_KEY]: { ...previous, ...patch } satisfies OneDriveSyncState });
}

async function rememberOneDriveSuccess(data: string, stat: OneDriveFileStat): Promise<void> {
  const hash = await sha256Hex(data);
  await chrome.storage.local.set({
    [ONEDRIVE_SYNC_KEY]: {
      remoteVersionToken: stat.versionToken,
      remoteEtag: stat.eTag,
      remoteLastModified: stat.lastModified,
      baseHash: hash,
      workingHash: hash,
      hasLocalChanges: false,
      hasRemoteChanges: false,
      syncPhase: 'IDLE',
      lastSuccessAt: new Date().toISOString(),
      failureMessage: undefined,
      retryCount: 0,
    } satisfies OneDriveSyncState,
  });
}

async function rememberOneDriveFailure(err: unknown): Promise<void> {
  const previous = (await loadOneDriveSyncState()) ?? {};
  await chrome.storage.local.set({
    [ONEDRIVE_SYNC_KEY]: {
      ...previous,
      syncPhase: 'FAILED',
      lastFailureAt: new Date().toISOString(),
      failureMessage: errorMessage(err),
      retryCount: (previous.retryCount ?? 0) + 1,
    } satisfies OneDriveSyncState,
  });
}

function armAutoLock(): void {
  chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: AUTO_LOCK_MINUTES });
}

async function hasOffscreen(): Promise<boolean> {
  return (await chrome.offscreen.hasDocument?.()) ?? false;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS' as chrome.offscreen.Reason],
    justification: 'Hold the decrypted KeePass vault in memory and run the Argon2 KDF.',
  });
}

async function callOffscreen(payload: OffscreenOp): Promise<unknown> {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', payload });
  if (!res || res.ok !== true) {
    throw new Error(res && !res.ok ? res.error : 'Offscreen call failed');
  }
  return res.value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
