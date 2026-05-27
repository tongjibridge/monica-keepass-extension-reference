// Standalone validation of the KDBX crypto path (Argon2 wiring + round-trip).
// Run: node scripts/smoke.mjs
import kdbxwebDefault from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

const kdbxweb = kdbxwebDefault.default ?? kdbxwebDefault;
const { Kdbx, Credentials, ProtectedValue, CryptoEngine, Consts } = kdbxweb;

CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const params = {
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    parallelism,
    iterations,
    memorySize: memory,
    hashLength: length,
    outputType: 'binary',
  };
  const hash = type === CryptoEngine.Argon2TypeArgon2id ? await argon2id(params) : await argon2d(params);
  return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
});

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok:', msg);
}

const PW = 'correct-horse-我的密码-🔐';

// --- create + add entry + save (exercises Argon2d KDF) ---
const db = Kdbx.create(new Credentials(ProtectedValue.fromString(PW)), 'Smoke Vault');
db.setKdf(Consts.KdfId.Argon2d);
const entry = db.createEntry(db.getDefaultGroup());
entry.fields.set('Title', 'GitHub');
entry.fields.set('UserName', 'alice@example.com');
entry.fields.set('Password', ProtectedValue.fromString('s3cret-token!'));
entry.fields.set('URL', 'https://github.com/login');
const saved = await db.save();
assert(saved.byteLength > 0, `saved ${saved.byteLength} bytes`);

// --- reload with correct password ---
const reopened = await Kdbx.load(saved, new Credentials(ProtectedValue.fromString(PW)));
const entries = reopened.getDefaultGroup().entries;
assert(entries.length === 1, 'one entry after reload');
const e = entries[0];
assert(e.fields.get('Title') === 'GitHub', 'title round-trips');
assert(e.fields.get('UserName') === 'alice@example.com', 'username round-trips');
assert(e.fields.get('Password').getText() === 's3cret-token!', 'password decrypts correctly');

// --- wrong password must fail ---
let rejected = false;
try {
  await Kdbx.load(saved, new Credentials(ProtectedValue.fromString('wrong-password')));
} catch {
  rejected = true;
}
assert(rejected, 'wrong password is rejected');

// --- key-file-only vault (null password + key file) ---
const keyFile = new Uint8Array(64);
globalThis.crypto.getRandomValues(keyFile);

const kdb = Kdbx.create(new Credentials(null, keyFile), 'KeyFile Vault');
kdb.setKdf(Consts.KdfId.Argon2d);
const ke = kdb.createEntry(kdb.getDefaultGroup());
ke.fields.set('Title', 'KeyOnly');
ke.fields.set('Password', ProtectedValue.fromString('kf-secret'));
const kfSaved = await kdb.save();

const kfReopened = await Kdbx.load(kfSaved, new Credentials(null, keyFile));
assert(kfReopened.getDefaultGroup().entries.length === 1, 'key-file-only vault reopens');
assert(
  kfReopened.getDefaultGroup().entries[0].fields.get('Password').getText() === 'kf-secret',
  'key-file-only entry decrypts',
);

let kfRejected = false;
const wrongKey = new Uint8Array(64);
globalThis.crypto.getRandomValues(wrongKey);
try {
  await Kdbx.load(kfSaved, new Credentials(null, wrongKey));
} catch {
  kfRejected = true;
}
assert(kfRejected, 'wrong key file is rejected');

console.log('\nALL SMOKE CHECKS PASSED');
