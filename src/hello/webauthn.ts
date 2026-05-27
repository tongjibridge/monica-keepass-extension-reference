import { bytesToBase64, base64ToBytes, type CredentialInput } from '@/src/messaging/protocol';

// Windows Hello via the WebAuthn platform authenticator.
//
// New enrollments use Windows Hello as the user-verification gate, then wrap
// the vault's composite credential with a non-extractable local AES key stored
// in IndexedDB. Older PRF-based enrollments are still supported at unlock time.
// Must run in a focused document (popup), not the worker.

const STORAGE_KEY = 'hello.enrollment';
const RP_NAME = 'Monica KeePass';
const KEY_DB = 'monica-keepass-hello';
const KEY_STORE = 'keys';

interface PrfEnrollment {
  mode?: 'prf';
  credentialId: string; // base64
  prfSalt: string; // base64
  iv: string; // base64
  wrapped: string; // base64 ciphertext of the JSON-encoded CredentialInput
}

interface LocalKeyEnrollment {
  mode: 'local-key';
  credentialId: string; // base64
  keyId: string;
  iv: string; // base64
  wrapped: string; // base64 ciphertext of the JSON-encoded CredentialInput
}

type Enrollment = PrfEnrollment | LocalKeyEnrollment;

function rpId(): string {
  // For chrome-extension:// origins the registrable id is the extension host.
  return location.hostname;
}

function randomBytes(len: number): Uint8Array {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}

async function deriveWrapKey(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('monica-keepass-hello-wrap'),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function getPrfResult(cred: PublicKeyCredential): ArrayBuffer | null {
  const ext = cred.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  return ext.prf?.results?.first ?? null;
}

function isLocalKeyEnrollment(enrollment: Enrollment): enrollment is LocalKeyEnrollment {
  return enrollment.mode === 'local-key';
}

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open Windows Hello key store'));
  });
}

async function keyStoreRequest<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, mode);
    let result: T;
    let settled = false;

    const req = action(tx.objectStore(KEY_STORE));
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () => {
      settled = true;
      reject(req.error ?? new Error('Windows Hello key store request failed'));
    };
    tx.oncomplete = () => {
      db.close();
      if (!settled) resolve(result);
    };
    tx.onerror = () => {
      db.close();
      if (!settled) reject(tx.error ?? new Error('Windows Hello key store transaction failed'));
    };
    tx.onabort = () => {
      db.close();
      if (!settled) reject(tx.error ?? new Error('Windows Hello key store transaction aborted'));
    };
  });
}

async function saveLocalKey(keyId: string, key: CryptoKey): Promise<void> {
  await keyStoreRequest('readwrite', (store) => store.put(key, keyId));
}

async function loadLocalKey(keyId: string): Promise<CryptoKey> {
  const key = await keyStoreRequest<CryptoKey | undefined>('readonly', (store) => store.get(keyId));
  if (!key) throw new Error('Windows Hello local key is missing. Disable and re-enable Windows Hello.');
  return key;
}

async function removeLocalKey(keyId: string): Promise<void> {
  await keyStoreRequest('readwrite', (store) => store.delete(keyId));
}

async function removeLocalKeyForEnrollment(enrollment?: Enrollment): Promise<void> {
  if (enrollment && isLocalKeyEnrollment(enrollment)) {
    await removeLocalKey(enrollment.keyId).catch(() => undefined);
  }
}

async function createLocalWrapKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrapCredential(key: CryptoKey, credential: CredentialInput): Promise<{ iv: Uint8Array; wrapped: ArrayBuffer }> {
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(credential)),
  );
  return { iv, wrapped };
}

async function saveEnrollment(enrollment: Enrollment): Promise<void> {
  const previous = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Enrollment | undefined;
  await chrome.storage.local.set({ [STORAGE_KEY]: enrollment });
  await removeLocalKeyForEnrollment(previous);
}

export async function isHelloAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function isHelloEnrolled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] != null;
}

/**
 * Registers a platform credential and stores the vault credential wrapped by the
 * PRF-derived key. Requires the vault to already be openable with `credential`.
 */
export async function enrollHello(credential: CredentialInput): Promise<void> {
  const userId = randomBytes(16);

  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId(), name: RP_NAME },
      user: { id: userId, name: 'monica-keepass', displayName: RP_NAME },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        // A discoverable platform credential keeps Windows Hello assertions
        // tied to this extension origin across browser restarts.
        residentKey: 'required',
        requireResidentKey: true,
      },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new Error('Credential creation cancelled');
  const credentialId = new Uint8Array(created.rawId);

  const key = await createLocalWrapKey();
  const keyId = bytesToBase64(randomBytes(16));
  const { iv, wrapped } = await wrapCredential(key, credential);
  await saveLocalKey(keyId, key);
  await saveEnrollment({
    mode: 'local-key',
    credentialId: bytesToBase64(credentialId),
    keyId,
    iv: bytesToBase64(iv),
    wrapped: bytesToBase64(wrapped),
  });
}

async function evaluatePrf(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<ArrayBuffer | null> {
  const asserted = (await navigator.credentials.get({
    publicKey: {
      rpId: rpId(),
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!asserted) return null;
  return getPrfResult(asserted);
}

async function assertHello(credentialId: Uint8Array): Promise<void> {
  const asserted = (await navigator.credentials.get({
    publicKey: {
      rpId: rpId(),
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!asserted) throw new Error('Windows Hello verification cancelled');
}

/** Triggers Windows Hello and returns the unwrapped vault credential. */
export async function unlockWithHello(): Promise<CredentialInput> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const enrollment = stored[STORAGE_KEY] as Enrollment | undefined;
  if (!enrollment) throw new Error('Windows Hello is not set up');

  const credentialId = base64ToBytes(enrollment.credentialId);
  const key = isLocalKeyEnrollment(enrollment)
    ? await loadLocalKeyAfterHello(credentialId, enrollment.keyId)
    : await loadPrfKeyAfterHello(credentialId, base64ToBytes(enrollment.prfSalt));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(enrollment.iv) },
    key,
    base64ToBytes(enrollment.wrapped),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as CredentialInput;
}

async function loadLocalKeyAfterHello(credentialId: Uint8Array, keyId: string): Promise<CryptoKey> {
  await assertHello(credentialId);
  return loadLocalKey(keyId);
}

async function loadPrfKeyAfterHello(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKey> {
  const prfOutput = await evaluatePrf(credentialId, prfSalt);
  if (!prfOutput) throw new Error('Failed to obtain Hello secret');
  return deriveWrapKey(prfOutput);
}

export async function clearHello(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  await removeLocalKeyForEnrollment(stored[STORAGE_KEY] as Enrollment | undefined);
  await chrome.storage.local.remove(STORAGE_KEY);
}
