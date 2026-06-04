import { argon2id } from 'hash-wasm';

// Self-contained encrypted backup bundle. A second, independent layer of
// encryption that wraps allowlisted chrome.storage.local values into a single
// portable .mkbackup file. Designed for cross-machine migration: device-bound
// state (Hello enrollment, OneDrive refresh token) is never included.

export interface BackupCredential {
  password?: string;
  /** Raw bytes of a user-chosen key file. Hashed before feeding the KDF. */
  keyFile?: Uint8Array;
}

export interface BackupEnvelope {
  format: 'monica-keepass-backup';
  version: 1;
  createdAt: string;
  extensionVersion?: string;
  kdf: {
    algo: 'Argon2id';
    saltB64: string;
    memKiB: number;
    iterations: number;
    parallelism: number;
  };
  cipher: {
    algo: 'AES-256-GCM';
    ivB64: string;
    aad: string;
  };
  ciphertextB64: string;
}

export interface BackupPayload {
  exportedAt: string;
  extensionVersion?: string;
  /** Allowlisted chrome.storage.local entries, keyed by storage key. */
  storage: Record<string, unknown>;
}

const FORMAT_TAG = 'monica-keepass-backup';
const AAD = 'monica-keepass-backup-v1';

const DEFAULT_KDF = {
  memKiB: 65536, // 64 MiB
  iterations: 3,
  parallelism: 2,
};

const KDF_INFO_PW = new TextEncoder().encode('pw');
const KDF_INFO_KF = new TextEncoder().encode('kf');

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(len: number): Uint8Array {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/**
 * Composite credential -> Argon2id input. We pre-hash each factor so a huge
 * key file does not blow up the KDF input, then domain-separate the password
 * and key-file hashes so swapping which factor a user supplied changes the
 * derived key.
 */
async function compositeKdfInput(credential: BackupCredential): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];

  if (credential.password) {
    parts.push(KDF_INFO_PW);
    parts.push(await sha256(enc.encode(credential.password.normalize('NFC'))));
  }
  if (credential.keyFile && credential.keyFile.length > 0) {
    parts.push(KDF_INFO_KF);
    parts.push(await sha256(credential.keyFile));
  }
  if (parts.length === 0) {
    throw new Error('A backup password or key file is required');
  }

  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function deriveAesKey(
  credential: BackupCredential,
  salt: Uint8Array,
  params: { memKiB: number; iterations: number; parallelism: number },
): Promise<CryptoKey> {
  const input = await compositeKdfInput(credential);
  const hash = await argon2id({
    password: input,
    salt,
    memorySize: params.memKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function exportBackup(
  storage: Record<string, unknown>,
  credential: BackupCredential,
  extensionVersion?: string,
): Promise<Uint8Array> {
  if (!credential.password && (!credential.keyFile || credential.keyFile.length === 0)) {
    throw new Error('A backup password or key file is required');
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(credential, salt, DEFAULT_KDF);

  const exportedAt = new Date().toISOString();
  const payload: BackupPayload = { exportedAt, extensionVersion, storage };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const aad = new TextEncoder().encode(AAD);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );

  const envelope: BackupEnvelope = {
    format: FORMAT_TAG,
    version: 1,
    createdAt: exportedAt,
    extensionVersion,
    kdf: {
      algo: 'Argon2id',
      saltB64: bytesToB64(salt),
      memKiB: DEFAULT_KDF.memKiB,
      iterations: DEFAULT_KDF.iterations,
      parallelism: DEFAULT_KDF.parallelism,
    },
    cipher: { algo: 'AES-256-GCM', ivB64: bytesToB64(iv), aad: AAD },
    ciphertextB64: bytesToB64(ciphertext),
  };

  return new TextEncoder().encode(JSON.stringify(envelope, null, 2));
}

export async function importBackup(
  bytes: Uint8Array,
  credential: BackupCredential,
): Promise<BackupPayload> {
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes)) as BackupEnvelope;
  } catch {
    throw new Error('Not a valid Monica KeePass backup file');
  }

  if (envelope.format !== FORMAT_TAG) {
    throw new Error('Not a Monica KeePass backup file');
  }
  if (envelope.version !== 1) {
    throw new Error(`Unsupported backup version: ${envelope.version}`);
  }
  if (envelope.kdf.algo !== 'Argon2id') {
    throw new Error(`Unsupported KDF: ${envelope.kdf.algo}`);
  }
  if (envelope.cipher.algo !== 'AES-256-GCM') {
    throw new Error(`Unsupported cipher: ${envelope.cipher.algo}`);
  }

  const salt = b64ToBytes(envelope.kdf.saltB64);
  const iv = b64ToBytes(envelope.cipher.ivB64);
  const ciphertext = b64ToBytes(envelope.ciphertextB64);
  const aad = new TextEncoder().encode(envelope.cipher.aad);

  const key = await deriveAesKey(credential, salt, {
    memKiB: envelope.kdf.memKiB,
    iterations: envelope.kdf.iterations,
    parallelism: envelope.kdf.parallelism,
  });

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    throw new Error('Wrong backup password or key file');
  }

  let payload: BackupPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext)) as BackupPayload;
  } catch {
    throw new Error('Backup payload is corrupted');
  }
  if (!payload.storage || typeof payload.storage !== 'object') {
    throw new Error('Backup payload is missing storage data');
  }
  return payload;
}

export function backupFilenameFor(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `monica-keepass-backup-${stamp}.mkbackup`;
}
