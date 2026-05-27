import { Credentials, Kdbx, ProtectedValue } from 'kdbxweb';
import type { KdbxEntry, KdbxEntryField, KdbxGroup } from 'kdbxweb';
import { installArgon2 } from '@/src/crypto/argon2';
import type {
  EntryDetail,
  EntrySummary,
  GroupSummary,
  NewEntryInput,
  UpdateEntryInput,
  VaultMeta,
} from './types';

// Holds the decrypted KeePass database in memory. Intended to live inside the
// long-lived offscreen document; lock() drops all references so secrets do not
// outlive an explicit lock or idle timeout.

let db: Kdbx | null = null;

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
    db = await Kdbx.load(data, credentials(password, keyFile));
    return this.getMeta();
  },

  async createNew(name: string, password: string): Promise<ArrayBuffer> {
    installArgon2();
    db = Kdbx.create(credentials(password), name);
    return db.save();
  },

  lock(): void {
    db = null;
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
