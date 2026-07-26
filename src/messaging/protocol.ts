import type {
  EntryDetail,
  EntrySummary,
  GroupSummary,
  KdfInfo,
  KdfProfile,
  NewEntryInput,
  UpdateEntryInput,
  VaultMeta,
} from '@/src/vault/types';
import type { OneDriveConfig, OneDriveFileStat, OneDriveListItem } from '@/src/onedrive/graph';
import type { CredentialSnapshot, PendingSuggestionMetadata } from '@/src/autofill/suggest';

export type { CredentialSnapshot } from '@/src/autofill/suggest';

/**
 * Pending suggestion DTO without the password. Returned to content script and
 * popup; the actual secret lives in the offscreen document and its opaque
 * token remains private to the background. P0-5: neither value may appear here.
 */
export type PendingSuggestionPublic = PendingSuggestionMetadata & {
  /** Non-secret correlation ID used to reject stale cross-tab prompts. */
  id: string;
};

/**
 * Backup credential as sent over chrome.runtime messaging. Binary key file
 * travels as base64 because the messaging boundary serializes with JSON.
 */
export interface BackupCredentialInput {
  password?: string;
  keyFileB64?: string;
}

export interface BackupExportLocalResult {
  data: string; // base64 of the encrypted bundle bytes
  suggestedName: string;
}

export interface BackupOneDriveResult {
  message: string;
  path: string;
  stat: OneDriveFileStat | null;
}

// chrome.runtime messaging serializes with JSON, so binary payloads travel as
// base64 strings rather than ArrayBuffers.

export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---- caller (popup / content / options) -> background ----

// A KeePass composite key: password and/or key file. Both optional, but at
// least one must be present. keyFile is base64-encoded bytes.
export interface CredentialInput {
  password: string | null;
  keyFile?: string;
}

export type BgRequest =
  | { type: 'vault.status' }
  | { type: 'vault.import'; data: string; name?: string }
  | { type: 'vault.createNew'; name: string; password: string }
  | { type: 'vault.unlock'; credential: CredentialInput; rememberKeyFile?: boolean }
  | { type: 'vault.lock' }
  | { type: 'vault.forgetKeyFile' }
  | { type: 'vault.listEntries' }
  | { type: 'vault.pickerEntries'; url: string }
  | { type: 'vault.listGroups' }
  | { type: 'vault.getEntry'; id: string; reveal: boolean }
  | { type: 'vault.add'; input: NewEntryInput }
  | { type: 'vault.update'; input: UpdateEntryInput }
  | { type: 'vault.delete'; id: string }
  | { type: 'vault.match'; url: string }
  | { type: 'vault.export' }
  | { type: 'vault.kdfInfo' }
  | { type: 'vault.setKdf'; profile: Exclude<KdfProfile, 'custom'> }
  | { type: 'vault.importCsv'; csv: string }
  | { type: 'vault.capture'; snapshot: CredentialSnapshot }
  | { type: 'vault.applyPending'; pendingId: string; entryId?: string }
  | { type: 'vault.dismissPending'; pendingId: string }
  | { type: 'backup.exportLocal'; credential: BackupCredentialInput }
  | { type: 'backup.exportToOneDrive'; credential: BackupCredentialInput; path?: string }
  | { type: 'backup.importLocal'; data: string; credential: BackupCredentialInput }
  | { type: 'backup.importFromOneDrive'; path: string; credential: BackupCredentialInput }
  | { type: 'onedrive.status' }
  | { type: 'onedrive.configure'; clientId: string; remotePath: string }
  | { type: 'onedrive.connect' }
  | { type: 'onedrive.disconnect' }
  | { type: 'onedrive.list'; path: string }
  | { type: 'onedrive.pull' }
  | { type: 'onedrive.push' }
  | { type: 'onedrive.sync'; credential?: CredentialInput | null };

export interface VaultStatus {
  unlocked: boolean;
  hasVault: boolean;
  helloEnrolled: boolean;
  rememberedKeyFile: boolean;
  meta: VaultMeta | null;
  pending: PendingSuggestionPublic | null;
  /** 当前累计解锁失败次数（解锁成功时重置为 0）。 */
  failedAttempts: number;
  /** 锁定截止时间戳（Date.now() ms），null 表示未锁定。 */
  lockdownUntil: number | null;
}

export interface OneDriveSyncState {
  remoteVersionToken?: string;
  remoteEtag?: string;
  remoteLastModified?: string;
  baseHash?: string;
  workingHash?: string;
  hasLocalChanges?: boolean;
  hasRemoteChanges?: boolean;
  syncPhase?: 'IDLE' | 'COMPARING' | 'DOWNLOADING' | 'UPLOADING' | 'MERGING' | 'CONFLICT' | 'FAILED';
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureMessage?: string;
  retryCount?: number;
}

export interface OneDriveStatus {
  configured: boolean;
  connected: boolean;
  redirectUrl: string;
  config: OneDriveConfig | null;
  sync: OneDriveSyncState | null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
}

export interface OneDriveSyncResult {
  action: 'connected' | 'configured' | 'disconnected' | 'pulled' | 'pushed' | 'synced' | 'merged' | 'conflict';
  message: string;
  stat?: OneDriveFileStat | null;
  conflictPath?: string;
}

export type BgResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface BgResultMap {
  'vault.status': VaultStatus;
  'vault.import': VaultStatus;
  'vault.createNew': VaultStatus;
  'vault.unlock': VaultStatus;
  'vault.lock': VaultStatus;
  'vault.forgetKeyFile': VaultStatus;
  'vault.listEntries': EntrySummary[];
  'vault.pickerEntries': EntrySummary[];
  'vault.listGroups': GroupSummary[];
  'vault.getEntry': EntryDetail;
  'vault.add': EntrySummary;
  'vault.update': EntrySummary;
  'vault.delete': null;
  'vault.match': EntrySummary[];
  'vault.export': string;
  'vault.kdfInfo': KdfInfo;
  'vault.setKdf': KdfInfo;
  'vault.importCsv': ImportResult;
  // Returns the resulting suggestion (without password) so the capturing tab
  // can render an in-page save/update prompt (null = nothing to suggest).
  'vault.capture': PendingSuggestionPublic | null;
  'vault.applyPending': VaultStatus;
  'vault.dismissPending': VaultStatus;
  'backup.exportLocal': BackupExportLocalResult;
  'backup.exportToOneDrive': BackupOneDriveResult;
  'backup.importLocal': VaultStatus;
  'backup.importFromOneDrive': VaultStatus;
  'onedrive.status': OneDriveStatus;
  'onedrive.configure': OneDriveStatus;
  'onedrive.connect': OneDriveSyncResult;
  'onedrive.disconnect': OneDriveStatus;
  'onedrive.list': OneDriveListItem[];
  'onedrive.pull': OneDriveSyncResult;
  'onedrive.push': OneDriveSyncResult;
  'onedrive.sync': OneDriveSyncResult;
}

export async function callBackground<T extends BgRequest>(
  req: T,
): Promise<BgResultMap[T['type']]> {
  const res: BgResponse = await chrome.runtime.sendMessage(req);
  if (!res || res.ok !== true) {
    throw new Error(res && !res.ok ? res.error : 'No response from background');
  }
  return res.value as BgResultMap[T['type']];
}

// ---- background -> offscreen ----

export type OffscreenOp =
  | { op: 'open'; data: string; password: string | null; keyFile?: string }
  | { op: 'createNew'; name: string; password: string }
  | { op: 'lock' }
  | { op: 'status' }
  | { op: 'meta' }
  | { op: 'listGroups' }
  | { op: 'listEntries' }
  | { op: 'matchEntries'; url: string }
  | { op: 'pickerEntries'; url: string }
  | { op: 'getEntry'; id: string; reveal: boolean }
  | { op: 'preparePending'; snapshot: CredentialSnapshot }
  | { op: 'add'; input: NewEntryInput }
  | { op: 'update'; input: UpdateEntryInput }
  | { op: 'delete'; id: string }
  | { op: 'save' }
  | { op: 'kdfInfo' }
  | { op: 'setKdf'; profile: Exclude<KdfProfile, 'custom'> }
  | { op: 'importEntries'; inputs: NewEntryInput[] }
  | { op: 'mergeRemote'; data: string; password: string | null; keyFile?: string }
  | {
      op: 'applyPending';
      token: string;
      action: 'save';
      title: string;
      username: string;
      url: string;
    }
  | { op: 'applyPending'; token: string; action: 'update'; entryId: string }
  | { op: 'rollbackPending'; token: string }
  | { op: 'commitPending'; token: string }
  | { op: 'clearPending' };

export interface OffscreenEnvelope {
  target: 'offscreen';
  payload: OffscreenOp;
}
