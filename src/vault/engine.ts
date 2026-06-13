import { Consts, Credentials, Int64, Kdbx, ProtectedValue, VarDictionary } from 'kdbxweb';
import type { KdbxEntry, KdbxEntryField, KdbxGroup } from 'kdbxweb';
import { clearArgon2Cache, installArgon2 } from '@/src/crypto/argon2';
import type {
  EntryDetail,
  EntrySummary,
  GroupSummary,
  KdfInfo,
  KdfProfile,
  NewEntryInput,
  UpdateEntryInput,
  VaultMeta,
} from './types';

// Holds the decrypted KeePass database in memory. Intended to live inside the
// long-lived offscreen document; lock() drops all references so secrets do not
// outlive an explicit lock or idle timeout.

let db: Kdbx | null = null;

// Argon2 cost presets (id variant). Memory in KiB. These balance browser KDF
// latency against brute-force resistance; the file is also protected by the OS
// account, optional Windows Hello, and optional key file.
const KDF_PRESETS: Record<Exclude<KdfProfile, 'custom'>, {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}> = {
  fast: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
  balanced: { memoryKiB: 65536, iterations: 3, parallelism: 2 },
  secure: { memoryKiB: 262144, iterations: 4, parallelism: 2 },
};

// Track headers whose generateSalts has been wrapped so we don't double-wrap.
const frozenHeaders = new WeakSet<object>();

/**
 * kdbxweb regenerates every salt — including the Argon2 salt 'S' — on each save,
 * which forces a fresh (expensive) KDF run every time. Freezing 'S' for the
 * session keeps the KDF transform key stable so it can be memoized, while the
 * master seed and IV stay fresh per save — so the data-encryption key still
 * differs every save and no keystream is reused.
 */
function freezeKdfSalt(d: Kdbx): void {
  const header = d.header as unknown as {
    generateSalts: () => void;
    kdfParameters?: VarDictionary;
  };
  if (frozenHeaders.has(header)) return;
  const original = header.generateSalts.bind(header);
  header.generateSalts = () => {
    const previousSalt = header.kdfParameters?.get('S');
    original();
    if (previousSalt instanceof ArrayBuffer && header.kdfParameters) {
      header.kdfParameters.set('S', VarDictionary.ValueType.Bytes, previousSalt);
    }
  };
  frozenHeaders.add(header);
}

function kdfName(d: Kdbx): KdfInfo['kdf'] {
  const uuid = d.header.kdfParameters?.get('$UUID');
  if (!(uuid instanceof ArrayBuffer)) return 'unknown';
  const b64 = btoa(String.fromCharCode(...new Uint8Array(uuid)));
  if (b64 === Consts.KdfId.Argon2id) return 'argon2id';
  if (b64 === Consts.KdfId.Argon2d) return 'argon2d';
  if (b64 === Consts.KdfId.Aes) return 'aes';
  return 'unknown';
}

function matchProfile(memoryKiB: number, iterations: number, parallelism: number): KdfProfile {
  for (const [name, p] of Object.entries(KDF_PRESETS)) {
    if (p.memoryKiB === memoryKiB && p.iterations === iterations && p.parallelism === parallelism) {
      return name as KdfProfile;
    }
  }
  return 'custom';
}

/** Apply Argon2id cost parameters in place. Does not save. */
function applyKdfProfile(d: Kdbx, profile: Exclude<KdfProfile, 'custom'>): void {
  const preset = KDF_PRESETS[profile];
  const current = kdfName(d);
  // Switch AES-KDF / unknown vaults to modern Argon2id; keep existing Argon2.
  if (current !== 'argon2id' && current !== 'argon2d') {
    d.setKdf(Consts.KdfId.Argon2id);
  }
  const params = d.header.kdfParameters;
  if (!params) throw new Error('Vault has no KDF parameters');
  params.set('M', VarDictionary.ValueType.UInt64, Int64.from(preset.memoryKiB * 1024));
  params.set('I', VarDictionary.ValueType.UInt64, Int64.from(preset.iterations));
  params.set('P', VarDictionary.ValueType.UInt32, preset.parallelism);
  // Fresh salt for the new parameters; the freeze wrapper preserves it for the
  // rest of the session, and the memo is invalidated by the changed inputs.
  params.set('S', VarDictionary.ValueType.Bytes, crypto.getRandomValues(new Uint8Array(32)).buffer);
  clearArgon2Cache();
}

function fieldText(value: KdbxEntryField | undefined): string {
  if (value == null) return '';
  if (value instanceof ProtectedValue) return value.getText();
  return String(value);
}

function isRecycleBin(group: KdbxGroup): boolean {
  const binUuid = db?.meta.recycleBinUuid;
  return binUuid != null && !binUuid.empty && group.uuid.equals(binUuid);
}

function* walkEntries(group: KdbxGroup): Generator<KdbxEntry> {
  for (const entry of group.entries) yield entry;
  for (const child of group.groups) {
    if (isRecycleBin(child)) continue;
    yield* walkEntries(child);
  }
}

function requireDb(): Kdbx {
  if (!db) throw new Error('Vault is locked');
  return db;
}

function summarize(entry: KdbxEntry): EntrySummary {
  const password = entry.fields.get('Password');
  return {
    id: entry.uuid.id,
    title: fieldText(entry.fields.get('Title')),
    username: fieldText(entry.fields.get('UserName')),
    url: fieldText(entry.fields.get('URL')),
    groupId: entry.parentGroup ? entry.parentGroup.uuid.id : '',
    hasPassword: password != null && fieldText(password).length > 0,
    hasTotp: entry.fields.has('otp'),
  };
}

function findEntry(id: string): KdbxEntry {
  const root = requireDb().getDefaultGroup();
  for (const entry of walkEntries(root)) {
    if (entry.uuid.id === id) return entry;
  }
  throw new Error(`Entry not found: ${id}`);
}

function credentials(password: string | null, keyFile?: ArrayBuffer): Credentials {
  // A key-file-only vault must get a null password component, not an empty one,
  // or the composite key won't match.
  const pw = password ? ProtectedValue.fromString(password) : null;
  if (!pw && !keyFile) throw new Error('A password or key file is required');
  return new Credentials(pw, keyFile ?? null);
}

export const VaultEngine = {
  isUnlocked(): boolean {
    return db != null;
  },

  async open(
    data: ArrayBuffer,
    password: string | null,
    keyFile?: ArrayBuffer,
  ): Promise<VaultMeta> {
    installArgon2();
    clearArgon2Cache();
    db = await Kdbx.load(data, credentials(password, keyFile));
    freezeKdfSalt(db);
    return this.getMeta();
  },

  async createNew(name: string, password: string): Promise<ArrayBuffer> {
    installArgon2();
    clearArgon2Cache();
    db = Kdbx.create(credentials(password), name);
    freezeKdfSalt(db);
    // New vaults default to the balanced Argon2 preset for a predictable
    // speed/security tradeoff in the browser.
    applyKdfProfile(db, 'balanced');
    return db.save();
  },

  lock(): void {
    db = null;
    clearArgon2Cache();
  },

  getKdfInfo(): KdfInfo {
    const d = requireDb();
    const params = d.header.kdfParameters;
    const memoryBytes = params ? Number(params.get('M') ?? 0) : 0;
    const iterations = params ? Number(params.get('I') ?? 0) : 0;
    const parallelism = params ? Number(params.get('P') ?? 0) : 0;
    const memoryKiB = Math.round(memoryBytes / 1024);
    return {
      kdf: kdfName(d),
      memoryKiB,
      iterations,
      parallelism,
      profile: matchProfile(memoryKiB, iterations, parallelism),
    };
  },

  /** Re-key the vault to a cost preset. Caller must persist (save) afterwards. */
  setKdfProfile(profile: Exclude<KdfProfile, 'custom'>): KdfInfo {
    const d = requireDb();
    applyKdfProfile(d, profile);
    return this.getKdfInfo();
  },

  getMeta(): VaultMeta {
    const d = requireDb();
    const root = d.getDefaultGroup();
    let entryCount = 0;
    for (const _ of walkEntries(root)) entryCount++;
    let groupCount = 0;
    const countGroups = (g: KdbxGroup) => {
      for (const child of g.groups) {
        if (isRecycleBin(child)) continue;
        groupCount++;
        countGroups(child);
      }
    };
    countGroups(root);
    return { name: d.meta.name ?? 'KeePass', entryCount, groupCount };
  },

  listGroups(): GroupSummary[] {
    const root = requireDb().getDefaultGroup();
    const out: GroupSummary[] = [];
    const walk = (g: KdbxGroup, parentId: string | null) => {
      out.push({ id: g.uuid.id, name: g.name ?? '', parentId });
      for (const child of g.groups) {
        if (isRecycleBin(child)) continue;
        walk(child, g.uuid.id);
      }
    };
    walk(root, null);
    return out;
  },

  listEntries(): EntrySummary[] {
    const root = requireDb().getDefaultGroup();
    return [...walkEntries(root)].map(summarize);
  },

  getEntry(id: string, reveal: boolean): EntryDetail {
    const entry = findEntry(id);
    const detail: EntryDetail = {
      ...summarize(entry),
      notes: fieldText(entry.fields.get('Notes')),
    };
    if (reveal) {
      detail.password = fieldText(entry.fields.get('Password'));
      const otp = entry.fields.get('otp');
      if (otp != null) detail.otp = fieldText(otp);
    }
    return detail;
  },

  addEntry(input: NewEntryInput): EntrySummary {
    const d = requireDb();
    const group = input.groupId ? d.getGroup(input.groupId) : d.getDefaultGroup();
    if (!group) throw new Error(`Group not found: ${input.groupId}`);
    const entry = d.createEntry(group);
    entry.fields.set('Title', input.title);
    entry.fields.set('UserName', input.username);
    entry.fields.set('Password', ProtectedValue.fromString(input.password));
    entry.fields.set('URL', input.url);
    entry.fields.set('Notes', input.notes);
    if (input.otp) entry.fields.set('otp', ProtectedValue.fromString(input.otp));
    entry.times.update();
    return summarize(entry);
  },

  updateEntry(input: UpdateEntryInput): EntrySummary {
    const entry = findEntry(input.id);
    entry.pushHistory();
    if (input.title !== undefined) entry.fields.set('Title', input.title);
    if (input.username !== undefined) entry.fields.set('UserName', input.username);
    if (input.password !== undefined)
      entry.fields.set('Password', ProtectedValue.fromString(input.password));
    if (input.url !== undefined) entry.fields.set('URL', input.url);
    if (input.notes !== undefined) entry.fields.set('Notes', input.notes);
    if (input.otp !== undefined) {
      if (input.otp) entry.fields.set('otp', ProtectedValue.fromString(input.otp));
      else entry.fields.delete('otp');
    }
    entry.times.update();
    return summarize(entry);
  },

  deleteEntry(id: string): void {
    const d = requireDb();
    const entry = findEntry(id);
    d.remove(entry);
  },

  async save(): Promise<ArrayBuffer> {
    return requireDb().save();
  },

  async mergeRemote(
    data: ArrayBuffer,
    password: string | null,
    keyFile?: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    installArgon2();
    const local = requireDb();
    const remote = await Kdbx.load(data, credentials(password, keyFile));
    local.merge(remote);
    return local.save();
  },
};
