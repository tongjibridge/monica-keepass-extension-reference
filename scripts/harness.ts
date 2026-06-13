// Integration check of the chrome-free business logic, bundled the same way the
// extension is (esbuild), so kdbxweb's CJS named-import interop is exercised too.
import { VaultEngine } from '@/src/vault/engine';
import { matchEntriesForUrl } from '@/src/autofill/match';
import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateEntropyBits,
  generatePassword,
} from '@/src/crypto/generator';
import {
  decideSuggestion,
  type CredentialSnapshot,
  type EnrichedEntry,
} from '@/src/autofill/suggest';
import { backupFilenameFor, exportBackup, importBackup } from '@/src/backup/codec';
import { argon2ComputeCount } from '@/src/crypto/argon2';

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAILED: ' + msg);
  passed++;
  console.log('  ok:', msg);
}

async function main() {
  // --- vault lifecycle ---
  const PW = 'master-我的密码-🔐';
  const created = await VaultEngine.createNew('Harness Vault', PW);
  assert(created.byteLength > 0, `createNew produced ${created.byteLength} bytes`);
  assert(VaultEngine.isUnlocked(), 'vault unlocked after createNew');

  // reopen from the saved bytes (fresh open path)
  const meta = await VaultEngine.open(created, PW);
  assert(meta.entryCount === 0, 'new vault has no entries');

  const a = VaultEngine.addEntry({
    title: 'GitHub',
    username: 'alice',
    password: 's3cret',
    url: 'https://github.com/login',
    notes: 'work',
  });
  VaultEngine.addEntry({
    title: 'Example',
    username: 'bob',
    password: 'pw2',
    url: 'https://login.example.co.uk/',
    notes: '',
  });
  assert(VaultEngine.listEntries().length === 2, 'two entries after add');

  const masked = VaultEngine.getEntry(a.id, false);
  assert(masked.password === undefined, 'masked getEntry hides password');
  const revealed = VaultEngine.getEntry(a.id, true);
  assert(revealed.password === 's3cret', 'revealed getEntry returns password');

  VaultEngine.updateEntry({ id: a.id, password: 'rotated' });
  assert(VaultEngine.getEntry(a.id, true).password === 'rotated', 'updateEntry rotates password');

  // persist + reopen to confirm edits survive serialization
  const saved = await VaultEngine.save();
  await VaultEngine.open(saved, PW);
  assert(VaultEngine.listEntries().length === 2, 'entries persist across save/open');
  const reAfter = VaultEngine.listEntries().find((e) => e.title === 'GitHub')!;
  assert(VaultEngine.getEntry(reAfter.id, true).password === 'rotated', 'rotated password persisted');

  // --- ① salt-freeze + Argon2 memoization: saves must not recompute the KDF ---
  const beforeSaves = argon2ComputeCount();
  for (let i = 0; i < 5; i++) {
    VaultEngine.updateEntry({ id: reAfter.id, password: `rot-${i}` });
    await VaultEngine.save();
  }
  assert(
    argon2ComputeCount() === beforeSaves,
    `5 saves reuse the cached KDF (0 extra Argon2 runs, was ${argon2ComputeCount() - beforeSaves})`,
  );
  // The frozen-salt output must still decrypt correctly after a real reopen.
  const afterFrozen = await VaultEngine.save();
  await VaultEngine.open(afterFrozen, PW);
  assert(
    VaultEngine.getEntry(VaultEngine.listEntries().find((e) => e.title === 'GitHub')!.id, true)
      .password === 'rot-4',
    'frozen-salt saves still reopen and decrypt',
  );

  // --- ② KDF profile: re-key to a different preset, vault still opens ---
  const fastInfo = VaultEngine.setKdfProfile('fast');
  assert(fastInfo.profile === 'fast' && fastInfo.memoryKiB === 19456, 'setKdfProfile(fast) applied');
  const beforeReKdf = argon2ComputeCount();
  const reKeyed = await VaultEngine.save();
  assert(argon2ComputeCount() === beforeReKdf + 1, 'changing KDF params forces exactly one recompute');
  await VaultEngine.open(reKeyed, PW);
  assert(VaultEngine.getKdfInfo().profile === 'fast', 're-keyed vault reopens with fast profile');
  assert(VaultEngine.getKdfInfo().kdf.startsWith('argon2'), 're-key keeps an Argon2 KDF');

  VaultEngine.deleteEntry(reAfter.id);
  assert(
    VaultEngine.listEntries().filter((e) => e.title === 'GitHub').length === 0,
    'deleteEntry removes from active list',
  );

  // --- autofill domain matching (Android/Bitwarden-style ranking) ---
  VaultEngine.addEntry({
    title: 'Example Exact',
    username: 'carol',
    password: 'pw3',
    url: 'https://example.co.uk/login',
    notes: '',
  });
  VaultEngine.addEntry({
    title: 'Example Sibling',
    username: 'dave',
    password: 'pw4',
    url: 'https://accounts.example.co.uk/',
    notes: '',
  });
  VaultEngine.addEntry({
    title: 'Multi URL',
    username: 'erin',
    password: 'pw5',
    url: 'https://first.example.net; https://second.example.org',
    notes: '',
  });
  VaultEngine.addEntry({
    title: 'https://auth.tavily.com/',
    username: 'frank',
    password: 'pw6',
    url: '',
    notes: '',
  });
  const entries = VaultEngine.listEntries();
  const m1 = matchEntriesForUrl(entries, 'https://www.example.co.uk/account');
  assert(m1.length === 3 && m1[0]!.title === 'Example Exact', 'ranks exact host before related domains');
  assert(m1.some((e) => e.title === 'Example'), 'matches parent/child subdomain relation');
  assert(m1.some((e) => e.title === 'Example Sibling'), 'matches same base domain sibling');
  const m2 = matchEntriesForUrl(entries, 'https://evil.com/');
  assert(m2.length === 0, 'no match for unrelated domain');
  const m3 = matchEntriesForUrl(entries, 'https://second.example.org/login');
  assert(m3.length === 1 && m3[0]!.title === 'Multi URL', 'matches secondary URL tokens');
  const m4 = matchEntriesForUrl(entries, 'https://auth.tavily.com/u/login/identifier');
  assert(m4.length === 1 && m4[0]!.username === 'frank', 'matches URL stored in title');

  // --- generator ---
  const pw = generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 24 });
  assert(pw.length === 24, 'generator honors length');
  assert(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw), 'generator covers classes');
  const many = new Set(Array.from({ length: 100 }, () => generatePassword(DEFAULT_PASSWORD_OPTIONS)));
  assert(many.size === 100, '100 generated passwords are unique');
  assert(estimateEntropyBits({ ...DEFAULT_PASSWORD_OPTIONS, length: 20 }) > 100, 'entropy estimate sane');

  // --- save/update decision (suggest.ts) ---
  const mkEntry = (
    overrides: Partial<EnrichedEntry> & Pick<EnrichedEntry, 'id' | 'username'>,
  ): EnrichedEntry => ({
    title: overrides.title ?? '',
    url: overrides.url ?? '',
    groupId: '',
    hasPassword: true,
    hasTotp: false,
    ...overrides,
  });

  const submitFor = (
    username: string,
    password: string,
    overrides: Partial<CredentialSnapshot> = {},
  ): CredentialSnapshot => ({
    url: 'https://example.com/login',
    username,
    password,
    kind: 'submit',
    ...overrides,
  });

  const sugSave = decideSuggestion(
    [mkEntry({ id: 'other', username: 'bob', password: 'pw' })],
    submitFor('alice', 'newpw'),
  );
  assert(sugSave?.action === 'save' && sugSave.newPassword === 'newpw', 'no user match → save');

  const sugSilent = decideSuggestion(
    [mkEntry({ id: 'a', username: 'Alice', password: 'same' })],
    submitFor('alice', 'same'),
  );
  assert(sugSilent === null, 'same username + same password → silent');

  const sugUpdate = decideSuggestion(
    [mkEntry({ id: 'a', username: 'alice', password: 'old' })],
    submitFor('alice', 'new'),
  );
  assert(
    sugUpdate?.action === 'update' && sugUpdate.entryId === 'a' && sugUpdate.newPassword === 'new',
    'same username + different password → update',
  );

  const sugChange = decideSuggestion(
    [
      mkEntry({ id: 'a', username: 'alice', password: 'wrongOld' }),
      mkEntry({ id: 'b', username: 'alice', password: 'rightOld' }),
    ],
    submitFor('alice', 'shinyNew', { kind: 'change-form', oldPassword: 'rightOld' }),
  );
  assert(
    sugChange?.action === 'update' && sugChange.entryId === 'b',
    'change-form picks entry matching oldPassword',
  );

  const sugChangeFallback = decideSuggestion(
    [
      mkEntry({ id: 'a', username: 'alice', password: 'nope' }),
      mkEntry({ id: 'b', username: 'alice', password: 'alsoNope' }),
    ],
    submitFor('alice', 'shinyNew', { kind: 'change-form', oldPassword: 'mystery' }),
  );
  assert(
    sugChangeFallback?.action === 'update' && sugChangeFallback.entryId === 'a',
    'change-form with no oldPassword match falls back to primary',
  );

  // --- backup codec ---
  const samplePayload = {
    'vault.file': { name: 'vault.kdbx', data: 'BASE64KDBXBYTES' },
    'vault.keyfile': 'BASE64KEYFILEBYTES',
    'onedrive.config': { clientId: 'client-x', remotePath: '/Apps/Vault/x.kdbx' },
    'onedrive.sync': { baseHash: 'abc', workingHash: 'abc' },
  };

  const exportedPw = await exportBackup(samplePayload, { password: '我的备份-密码🔐' }, '0.1.0');
  const importedPw = await importBackup(exportedPw, { password: '我的备份-密码🔐' });
  assert(
    JSON.stringify(importedPw.storage) === JSON.stringify(samplePayload),
    'backup round-trips with password only',
  );

  const keyFile = new Uint8Array(64);
  crypto.getRandomValues(keyFile);
  const exportedKf = await exportBackup(samplePayload, { keyFile }, '0.1.0');
  const importedKf = await importBackup(exportedKf, { keyFile });
  assert(
    JSON.stringify(importedKf.storage) === JSON.stringify(samplePayload),
    'backup round-trips with key file only',
  );

  const exportedBoth = await exportBackup(samplePayload, { password: 'pw', keyFile }, '0.1.0');
  const importedBoth = await importBackup(exportedBoth, { password: 'pw', keyFile });
  assert(
    JSON.stringify(importedBoth.storage) === JSON.stringify(samplePayload),
    'backup round-trips with password + key file',
  );

  await rejects(
    () => importBackup(exportedPw, { password: 'wrong' }),
    'wrong backup password is rejected',
  );

  const otherKeyFile = new Uint8Array(64);
  crypto.getRandomValues(otherKeyFile);
  await rejects(
    () => importBackup(exportedKf, { keyFile: otherKeyFile }),
    'wrong key file is rejected',
  );

  await rejects(
    () => importBackup(exportedBoth, { password: 'pw' }),
    'partial credential (missing key file) is rejected',
  );

  // Tampered ciphertext: flip one byte inside the envelope's ciphertextB64 field.
  const envelopeText = new TextDecoder().decode(exportedPw);
  const envelope = JSON.parse(envelopeText);
  const ct = atob(envelope.ciphertextB64);
  const tampered = ct.slice(0, 10) + String.fromCharCode((ct.charCodeAt(10) ^ 0x01) & 0xff) + ct.slice(11);
  envelope.ciphertextB64 = btoa(tampered);
  await rejects(
    () => importBackup(new TextEncoder().encode(JSON.stringify(envelope)), { password: '我的备份-密码🔐' }),
    'tampered ciphertext is rejected by GCM tag',
  );

  await rejects(
    () => importBackup(new TextEncoder().encode('{"format":"other","version":1}'), { password: 'x' }),
    'foreign format is rejected',
  );

  await rejects(
    () =>
      importBackup(
        new TextEncoder().encode('{"format":"monica-keepass-backup","version":99}'),
        { password: 'x' },
      ),
    'unknown version is rejected',
  );

  await rejects(
    () => exportBackup(samplePayload, {}, '0.1.0'),
    'exportBackup with no credential throws',
  );

  assert(/^monica-keepass-backup-\d{8}-\d{6}\.mkbackup$/.test(backupFilenameFor(new Date(2026, 4, 27, 18, 0, 0))), 'filename has timestamp');

  console.log(`\nALL ${passed} HARNESS CHECKS PASSED`);
}

async function rejects(fn: () => Promise<unknown>, msg: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('FAILED: ' + msg + ' (did not throw)');
  passed++;
  console.log('  ok:', msg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
