import {
  base64ToBytes,
  bytesToBase64,
  type BackupCredentialInput,
  type BackupExportLocalResult,
  type BackupOneDriveResult,
  type BgRequest,
  type CredentialInput,
  type OffscreenOp,
  type OneDriveStatus,
  type OneDriveSyncResult,
  type OneDriveSyncState,
  type PendingSuggestionPublic,
  type VaultStatus,
} from '@/src/messaging/protocol';
import {
  backupFilenameFor,
  exportBackup,
  importBackup,
  type BackupCredential,
} from '@/src/backup/codec';
import {
  toPendingSuggestionMetadata,
  type CredentialSnapshot,
  type PendingSuggestionMetadata,
} from '@/src/autofill/suggest';
import { csvToEntries } from '@/src/import/csv';
import type { VaultMeta } from '@/src/vault/types';
import type { ImportResult } from '@/src/messaging/protocol';
import {
  formatLockdownRemaining,
  lockdownDurationFor,
  LOCKDOWN_THRESHOLD,
} from '@/src/vault/lockdown';
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
const PENDING_KEY = 'autofill.pending';
const PENDING_TTL_ALARM = 'pendingTTL';
const PENDING_TTL_MS = 60_000;
const AUTO_LOCK_ALARM = 'autolock';
const AUTO_LOCK_MINUTES = 15;
const LOCKDOWN_KEY = 'vault.lockdown';

interface LockdownState {
  failedAttempts: number;
  /** epoch ms, null = not locked */
  lockedUntil: number | null;
}

// Storage keys included in a backup envelope. Device-specific items (Hello
// enrollment, OneDrive refresh token, ephemeral pending suggestions) are
// deliberately omitted so backups remain portable across machines.
const BACKUP_INCLUDED_KEYS = [
  FILE_KEY,
  KEYFILE_KEY,
  ONEDRIVE_CONFIG_KEY,
  ONEDRIVE_SYNC_KEY,
] as const;
const BACKUP_DEVICE_KEYS_TO_CLEAR = [HELLO_KEY, ONEDRIVE_TOKEN_KEY];

interface StoredFile {
  name: string;
  data: string; // base64 of the .kdbx bytes
}

type PendingSuggestionStored = PendingSuggestionPublic & { token: string };

let pendingStateTail: Promise<void> = Promise.resolve();
let offscreenCreationPromise: Promise<void> | null = null;

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
    void handleAlarm(alarm).catch((err: unknown) => {
      console.error('Alarm cleanup failed:', errorMessage(err));
    });
  });
});

async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name === AUTO_LOCK_ALARM) {
    await lockExistingVaultAndClearPending();
  } else if (alarm.name === PENDING_TTL_ALARM) {
    await clearPendingSafe();
  }
}

async function route(req: BgRequest): Promise<unknown> {
  switch (req.type) {
    case 'vault.status':
      return getStatus();

    case 'vault.import':
      // Switching vaults: drop any open vault and credentials tied to the old one.
      await lockExistingVaultAndClearPending();
      await chrome.storage.local.set({
        [FILE_KEY]: { name: req.name ?? 'vault.kdbx', data: req.data } satisfies StoredFile,
      });
      await chrome.storage.local.remove([KEYFILE_KEY, HELLO_KEY]);
      return getStatus();

    case 'vault.createNew': {
      await lockExistingVaultAndClearPending();
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
      // 锁定期间拒绝解锁尝试
      const lockdown = await loadLockdown();
      if (lockdown.lockedUntil && Date.now() < lockdown.lockedUntil) {
        throw new Error(
          `密码错误次数过多，请 ${formatLockdownRemaining(lockdown.lockedUntil)} 后再试`,
        );
      }

      const file = await loadFile();
      if (!file) throw new Error('No vault has been imported yet');
      const keyFile = req.credential.keyFile ?? (await loadRememberedKeyFile()) ?? undefined;
      try {
        await callOffscreen({
          op: 'open',
          data: file.data,
          password: req.credential.password,
          keyFile,
        });
      } catch {
        // 解锁失败：递增计数，达到阈值时触发阶梯式锁定
        const attempts = lockdown.failedAttempts + 1;
        const duration = lockdownDurationFor(attempts);
        const lockedUntil = duration > 0 ? Date.now() + duration : null;
        await saveLockdown({ failedAttempts: attempts, lockedUntil });
        if (lockedUntil) {
          throw new Error(
            `密码错误。连续失败 ${attempts} 次，已锁定 ${formatLockdownRemaining(lockedUntil)}`,
          );
        }
        const warning =
          attempts >= LOCKDOWN_THRESHOLD - 1
            ? '，再错 1 次将临时锁定'
            : '';
        throw new Error(`密码错误。已失败 ${attempts} 次${warning}`);
      }
      // 解锁成功：重置失败计数
      await saveLockdown({ failedAttempts: 0, lockedUntil: null });
      if (req.rememberKeyFile && req.credential.keyFile) {
        await chrome.storage.local.set({ [KEYFILE_KEY]: req.credential.keyFile });
      }
      armAutoLock();
      return getStatus();
    }

    case 'vault.lock':
      await lockExistingVaultAndClearPending();
      await chrome.alarms.clear(AUTO_LOCK_ALARM);
      return getStatus();

    case 'vault.forgetKeyFile':
      await chrome.storage.local.remove(KEYFILE_KEY);
      return getStatus();

    case 'vault.listEntries':
      armAutoLock();
      return callOffscreen({ op: 'listEntries' });

    case 'vault.pickerEntries': {
      armAutoLock();
      return callOffscreen({ op: 'pickerEntries', url: req.url });
    }

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
      return callOffscreen({ op: 'matchEntries', url: req.url });
    }

    case 'vault.export':
      return callOffscreen({ op: 'save' });

    case 'vault.importCsv':
      return importCsv(req.csv);

    case 'vault.kdfInfo':
      return callOffscreen({ op: 'kdfInfo' });

    case 'vault.setKdf': {
      const info = await callOffscreen({ op: 'setKdf', profile: req.profile });
      // Re-encrypt with the new parameters and store it.
      await persist();
      armAutoLock();
      return info;
    }

    case 'vault.capture':
      return handleCapture(req.snapshot);

    case 'vault.applyPending':
      await applyPending(req.pendingId, req.entryId);
      return getStatus();

    case 'vault.dismissPending':
      await dismissPending(req.pendingId);
      return getStatus();

    case 'backup.exportLocal':
      return backupExportLocal(req.credential);

    case 'backup.exportToOneDrive':
      return backupExportToOneDrive(req.credential, req.path);

    case 'backup.importLocal':
      await backupApplyImport(base64ToBytes(req.data), req.credential);
      return getStatus();

    case 'backup.importFromOneDrive':
      await backupImportFromOneDrive(req.path, req.credential);
      return getStatus();

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
  const pending = await loadPending();
  const lockdown = await loadLockdown();
  let unlocked = false;
  let meta: VaultMeta | null = null;
  if (await hasOffscreen()) {
    const status = (await callOffscreen({ op: 'status' })) as { unlocked: boolean };
    unlocked = status.unlocked;
    if (unlocked) meta = (await callOffscreen({ op: 'meta' })) as VaultMeta;
  }
  return {
    unlocked,
    hasVault: file != null,
    helloEnrolled,
    rememberedKeyFile,
    meta,
    pending,
    failedAttempts: lockdown.failedAttempts,
    lockdownUntil: lockdown.lockedUntil,
  };
}

async function importCsv(csv: string): Promise<ImportResult> {
  if (!(await hasOffscreen())) throw new Error('Unlock the vault first');
  const offscreenStatus = (await callOffscreen({ op: 'status' })) as { unlocked: boolean };
  if (!offscreenStatus.unlocked) throw new Error('Unlock the vault first');

  const { entries } = csvToEntries(csv);
  if (entries.length === 0) throw new Error('No password rows found in the CSV');

  const { added, skipped } = (await callOffscreen({
    op: 'importEntries',
    inputs: entries,
  })) as { added: number; skipped: number };

  if (added > 0) await persist();
  armAutoLock();
  return { imported: added, skipped, total: entries.length };
}

function withPendingState<T>(task: () => Promise<T>): Promise<T> {
  const run = pendingStateTail.then(task, task);
  pendingStateTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function handleCapture(snapshot: CredentialSnapshot): Promise<PendingSuggestionPublic | null> {
  return withPendingState(() => handleCaptureUnlocked(snapshot));
}

async function handleCaptureUnlocked(
  snapshot: CredentialSnapshot,
): Promise<PendingSuggestionPublic | null> {
  if (!snapshot?.password) return null;
  // Cannot decide save vs update without entries; drop while locked.
  if (!(await hasOffscreen())) return null;
  const offscreenStatus = (await callOffscreen({ op: 'status' })) as { unlocked: boolean };
  if (!offscreenStatus.unlocked) return null;

  const prepared = (await callOffscreen({
    op: 'preparePending',
    snapshot,
  })) as { token: string; suggestion: PendingSuggestionMetadata } | null;
  if (!prepared) return null;

  // Password matching and secret storage happen inside offscreen. Background
  // receives only an opaque token and explicitly allowlisted metadata.
  const publicSuggestion: PendingSuggestionPublic = {
    ...toPendingSuggestionMetadata(prepared.suggestion),
    id: crypto.randomUUID(),
  };
  const stored: PendingSuggestionStored = {
    ...publicSuggestion,
    token: prepared.token,
  };
  try {
    await setPendingStored(stored);
    await chrome.alarms.create(PENDING_TTL_ALARM, { delayInMinutes: 1 });
    return publicSuggestion;
  } catch (err) {
    await clearPendingUnlocked().catch(() => {});
    throw err;
  }
}

async function applyPending(pendingId: string, overrideEntryId?: string): Promise<void> {
  return withPendingState(() => applyPendingUnlocked(pendingId, overrideEntryId));
}

async function applyPendingUnlocked(
  pendingId: string,
  overrideEntryId?: string,
): Promise<void> {
  const pending = await loadPendingStoredUnlocked();
  if (!pending) throw new Error('No pending credential to save');
  if (pending.id !== pendingId) throw new Error('This credential prompt is no longer current');

  if (!(await hasOffscreen())) throw new Error('Unlock the vault first');
  const offscreenStatus = (await callOffscreen({ op: 'status' })) as { unlocked: boolean };
  if (!offscreenStatus.unlocked) throw new Error('Unlock the vault first');

  try {
    if (pending.action === 'save') {
      await callOffscreen({
        op: 'applyPending',
        token: pending.token,
        action: 'save',
        title: pending.origin || pending.url,
        username: pending.username,
        url: pending.url,
      });
    } else {
      const entryId = overrideEntryId ?? pending.entryId;
      if (!entryId) throw new Error('Pending update is missing an entry ID');
      await callOffscreen({
        op: 'applyPending',
        token: pending.token,
        action: 'update',
        entryId,
      });
    }
    await persist();
  } catch (err) {
    await callExistingOffscreen({
      op: 'rollbackPending',
      token: pending.token,
    }).catch((rollbackErr: unknown) => {
      console.error('Pending rollback failed:', errorMessage(rollbackErr));
    });
    throw err;
  }
  await callOffscreen({ op: 'commitPending', token: pending.token });
  await clearPendingMetadataUnlocked();
  armAutoLock();
}

/** Lazy TTL check: if the pending secret has expired, purge it. */
async function loadPending(): Promise<PendingSuggestionPublic | null> {
  const pending = await withPendingState(loadPendingStoredUnlocked);
  return pending
    ? { ...toPendingSuggestionMetadata(pending), id: pending.id }
    : null;
}

async function loadPendingStoredUnlocked(): Promise<PendingSuggestionStored | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] as PendingSuggestionStored | undefined;
  if (!pending) return null;
  if (typeof pending.token !== 'string') {
    await clearPendingUnlocked();
    return null;
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    await clearPendingUnlocked();
    return null;
  }
  return pending;
}

async function setPendingStored(suggestion: PendingSuggestionStored): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: suggestion });
  await safeSetBadge('1', '#2563eb');
}

/** Purge pending from session storage and zero the offscreen-held secret. */
async function clearPendingSafe(): Promise<void> {
  return withPendingState(clearPendingUnlocked);
}

async function dismissPending(pendingId: string): Promise<void> {
  return withPendingState(async () => {
    const pending = await loadPendingStoredUnlocked();
    if (!pending) return;
    if (pending.id !== pendingId) {
      throw new Error('This credential prompt is no longer current');
    }
    await clearPendingUnlocked();
  });
}

async function clearPendingMetadataUnlocked(): Promise<void> {
  const results = await Promise.allSettled([
    chrome.storage.session.remove(PENDING_KEY),
    safeSetBadge('', '#000000'),
    chrome.alarms.clear(PENDING_TTL_ALARM),
  ]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

async function clearPendingUnlocked(): Promise<void> {
  const results = await Promise.allSettled([
    clearPendingMetadataUnlocked(),
    callExistingOffscreen({ op: 'clearPending' }),
  ]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

async function lockExistingVaultAndClearPending(): Promise<void> {
  return withPendingState(async () => {
    const results = await Promise.allSettled([
      clearPendingUnlocked(),
      callExistingOffscreen({ op: 'lock' }),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  });
}

async function safeSetBadge(text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // chrome.action may not exist in test contexts; ignore.
  }
}

async function loadLockdown(): Promise<LockdownState> {
  const v = (await chrome.storage.local.get(LOCKDOWN_KEY))[LOCKDOWN_KEY] as
    | Partial<LockdownState>
    | undefined;
  if (v && typeof v.failedAttempts === 'number') {
    return {
      failedAttempts: v.failedAttempts,
      lockedUntil: typeof v.lockedUntil === 'number' ? v.lockedUntil : null,
    };
  }
  return { failedAttempts: 0, lockedUntil: null };
}

async function saveLockdown(state: LockdownState): Promise<void> {
  await chrome.storage.local.set({ [LOCKDOWN_KEY]: state });
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
    await lockExistingVaultAndClearPending();
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
      await rememberOneDriveSuccess(localData, created, localHash);
      return { action: 'pushed', message: 'OneDrive file did not exist, so the local vault was uploaded.', stat: created };
    }

    const localChanged = sync?.workingHash ? localHash !== sync.workingHash : false;
    const remoteChanged = sync?.remoteVersionToken
      ? remoteStat.versionToken !== sync.remoteVersionToken
      : false;

    if (!sync?.remoteVersionToken) {
      const remoteData = await readRemote(token, config.remotePath);
      if (localHash === (await sha256Hex(remoteData))) {
        await rememberOneDriveSuccess(localData, remoteStat, localHash);
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
        await rememberOneDriveSuccess(localData, remoteStat, localHash);
        return { action: 'synced', message: 'Vault is already in sync.', stat: remoteStat };
      }
      await updateOneDrivePhase({ syncPhase: 'UPLOADING' });
      const uploaded = await writeRemote(token, config.remotePath, localData, remoteStat.versionToken);
      await storeVaultFile(localData, fileNameFromPath(config.remotePath));
      await rememberOneDriveSuccess(localData, uploaded, localHash);
      return { action: 'pushed', message: 'Uploaded local changes to OneDrive.', stat: uploaded };
    }

    await updateOneDrivePhase({ syncPhase: localChanged ? 'MERGING' : 'DOWNLOADING' });
    const remoteData = await readRemote(token, config.remotePath);
    if (!localChanged) {
      await lockExistingVaultAndClearPending();
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

async function rememberOneDriveSuccess(
  data: string,
  stat: OneDriveFileStat,
  knownHash?: string,
): Promise<void> {
  const hash = knownHash ?? (await sha256Hex(data));
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
  if (!offscreenCreationPromise) {
    offscreenCreationPromise = (async () => {
      if (await hasOffscreen()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS' as chrome.offscreen.Reason],
        justification: 'Hold the decrypted KeePass vault in memory and run the Argon2 KDF.',
      });
    })().finally(() => {
      offscreenCreationPromise = null;
    });
  }
  await offscreenCreationPromise;
}

async function sendOffscreen(payload: OffscreenOp): Promise<unknown> {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', payload });
  if (!res || res.ok !== true) {
    throw new Error(res && !res.ok ? res.error : 'Offscreen call failed');
  }
  return res.value;
}

async function callOffscreen(payload: OffscreenOp): Promise<unknown> {
  await ensureOffscreen();
  return sendOffscreen(payload);
}

async function callExistingOffscreen(payload: OffscreenOp): Promise<unknown> {
  if (!(await hasOffscreen())) return undefined;
  return sendOffscreen(payload);
}

function toBackupCredential(input: BackupCredentialInput): BackupCredential {
  return {
    password: input.password || undefined,
    keyFile: input.keyFileB64 ? base64ToBytes(input.keyFileB64) : undefined,
  };
}

async function gatherBackupStorage(): Promise<Record<string, unknown>> {
  const stored = await chrome.storage.local.get([...BACKUP_INCLUDED_KEYS]);
  const out: Record<string, unknown> = {};
  for (const key of BACKUP_INCLUDED_KEYS) {
    if (stored[key] !== undefined) out[key] = stored[key];
  }
  return out;
}

function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version ?? '';
  } catch {
    return '';
  }
}

function backupDefaultRemotePath(vaultRemotePath: string): string {
  const idx = vaultRemotePath.lastIndexOf('/');
  const dir = idx > 0 ? vaultRemotePath.slice(0, idx) : '';
  const combined = `${dir}/${backupFilenameFor()}`;
  return normalizeRemotePath(combined);
}

async function backupExportLocal(
  credentialInput: BackupCredentialInput,
): Promise<BackupExportLocalResult> {
  const storage = await gatherBackupStorage();
  if (!storage[FILE_KEY]) throw new Error('No vault to back up');
  const bytes = await exportBackup(storage, toBackupCredential(credentialInput), extensionVersion());
  return { data: bytesToBase64(bytes), suggestedName: backupFilenameFor() };
}

async function backupExportToOneDrive(
  credentialInput: BackupCredentialInput,
  path?: string,
): Promise<BackupOneDriveResult> {
  const config = await loadOneDriveClientConfig();
  const token = await getOneDriveAccessToken(config);
  const storage = await gatherBackupStorage();
  if (!storage[FILE_KEY]) throw new Error('No vault to back up');
  const bytes = await exportBackup(storage, toBackupCredential(credentialInput), extensionVersion());

  const targetPath =
    (path && path.trim() ? normalizeRemotePath(path) : '') ||
    backupDefaultRemotePath(config.remotePath || '/');
  const stat = await writeRemote(token, targetPath, bytesToBase64(bytes), null);
  return { message: 'Uploaded backup to OneDrive.', path: targetPath, stat };
}

async function backupImportFromOneDrive(
  path: string,
  credentialInput: BackupCredentialInput,
): Promise<void> {
  if (!path || !path.trim()) throw new Error('OneDrive path is required');
  const config = await loadOneDriveClientConfig();
  const token = await getOneDriveAccessToken(config);
  const dataB64 = await readRemote(token, normalizeRemotePath(path));
  await backupApplyImport(base64ToBytes(dataB64), credentialInput);
}

async function backupApplyImport(
  bytes: Uint8Array,
  credentialInput: BackupCredentialInput,
): Promise<void> {
  // Decrypt before touching any local state — wrong credential must be a no-op.
  const payload = await importBackup(bytes, toBackupCredential(credentialInput));
  if (!payload.storage || typeof payload.storage !== 'object') {
    throw new Error('Backup is missing storage data');
  }
  if (!payload.storage[FILE_KEY]) {
    throw new Error('Backup does not contain a vault file');
  }

  // Lock the current vault and stop any pending autolock.
  await lockExistingVaultAndClearPending();
  try {
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
  } catch {}

  // Replace backup-relevant keys atomically: clear then write.
  await chrome.storage.local.remove([
    ...BACKUP_INCLUDED_KEYS,
    ...BACKUP_DEVICE_KEYS_TO_CLEAR,
  ]);

  // Restrict the write to the allowlist so a tampered backup can't sneak in
  // unexpected storage keys.
  const allowed: Record<string, unknown> = {};
  for (const key of BACKUP_INCLUDED_KEYS) {
    if (payload.storage[key] !== undefined) allowed[key] = payload.storage[key];
  }
  await chrome.storage.local.set(allowed);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
