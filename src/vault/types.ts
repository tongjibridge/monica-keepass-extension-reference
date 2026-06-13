// Serializable DTOs passed across extension contexts. Secrets (password, otp)
// are only ever included when a reveal is explicitly requested.

export interface EntrySummary {
  id: string;
  title: string;
  username: string;
  url: string;
  groupId: string;
  hasPassword: boolean;
  hasTotp: boolean;
}

export interface EntryDetail extends EntrySummary {
  notes: string;
  password?: string;
  otp?: string;
}

export interface GroupSummary {
  id: string;
  name: string;
  parentId: string | null;
}

export interface VaultMeta {
  name: string;
  entryCount: number;
  groupCount: number;
}

export type KdfProfile = 'fast' | 'balanced' | 'secure' | 'custom';

export interface KdfInfo {
  kdf: 'argon2id' | 'argon2d' | 'aes' | 'unknown';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  profile: KdfProfile;
}

export interface NewEntryInput {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  groupId?: string;
  otp?: string;
}

export interface UpdateEntryInput {
  id: string;
  title?: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  otp?: string;
}
