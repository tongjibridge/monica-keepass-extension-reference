// Integration check of the chrome-free business logic, bundled the same way the
// extension is (esbuild), so kdbxweb's CJS named-import interop is exercised too.
import { VaultEngine, getProtectedValueGetTextCount } from '@/src/vault/engine';
import { matchEntriesForUrl } from '@/src/autofill/match';
import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateEntropyBits,
  generatePassword,
} from '@/src/crypto/generator';
import {
  decideSuggestionFromComparisons,
  type ComparedEntry,
  type CredentialSnapshot,
} from '@/src/autofill/suggest';
import { backupFilenameFor, exportBackup, importBackup } from '@/src/backup/codec';
import { argon2ComputeCount } from '@/src/crypto/argon2';
import { csvToEntries, parseCsv } from '@/src/import/csv';
import {
  lockdownDurationFor,
  LOCKDOWN_THRESHOLD,
} from '@/src/vault/lockdown';

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

  // --- P0-1: list/match must not decrypt Password plaintext ---
  const beforeList = getProtectedValueGetTextCount();
  const listResult = VaultEngine.listEntries();
  assert(
    getProtectedValueGetTextCount() === beforeList,
    'listEntries does not decrypt ProtectedValue (getText not called)',
  );
  assert(
    listResult.find((e) => e.title === 'GitHub')!.hasPassword === true,
    'entry with password reports hasPassword=true',
  );
  assert(
    listResult.find((e) => e.title === 'Example')!.hasPassword === true,
    'second entry reports hasPassword=true',
  );

  // Empty-password entry must report hasPassword=false, also without decrypting.
  const emptyEntry = VaultEngine.addEntry({
    title: 'Empty-PW',
    username: 'nobody',
    password: '',
    url: 'https://empty.example.com/',
    notes: '',
  });
  const listWithEmpty = VaultEngine.listEntries();
  assert(
    listWithEmpty.find((e) => e.id === emptyEntry.id)!.hasPassword === false,
    'empty-password entry reports hasPassword=false',
  );
  assert(
    getProtectedValueGetTextCount() === beforeList,
    'listEntries still did not decrypt after adding empty-password entry',
  );
  VaultEngine.deleteEntry(emptyEntry.id);
  assert(VaultEngine.listEntries().length === 2, 'empty-password test entry removed');

  // match path must also avoid decryption
  const beforeMatch = getProtectedValueGetTextCount();
  matchEntriesForUrl(VaultEngine.listEntries(), 'https://github.com/login');
  assert(
    getProtectedValueGetTextCount() === beforeMatch,
    'match does not decrypt ProtectedValue (getText not called)',
  );
  // --- end P0-1 ---

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
  const mkCompared = (
    id: string,
    username: string,
    matchesNewPassword = false,
    matchesOldPassword = false,
  ): ComparedEntry => ({
    entry: {
      id,
      username,
      title: '',
      url: '',
      groupId: '',
      hasPassword: true,
      hasTotp: false,
    },
    matchesNewPassword,
    matchesOldPassword,
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

  const sugSave = decideSuggestionFromComparisons(
    [mkCompared('other', 'bob')],
    submitFor('alice', 'newpw'),
  );
  assert(sugSave?.action === 'save' && sugSave.newPassword === 'newpw', 'no user match → save');

  const sugSilent = decideSuggestionFromComparisons(
    [mkCompared('a', 'Alice', true)],
    submitFor('alice', 'same'),
  );
  assert(sugSilent === null, 'same username + same password → silent');

  const sugUpdate = decideSuggestionFromComparisons(
    [mkCompared('a', 'alice')],
    submitFor('alice', 'new'),
  );
  assert(
    sugUpdate?.action === 'update' && sugUpdate.entryId === 'a' && sugUpdate.newPassword === 'new',
    'same username + different password → update',
  );

  const sugChange = decideSuggestionFromComparisons(
    [
      mkCompared('a', 'alice'),
      mkCompared('b', 'alice', false, true),
    ],
    submitFor('alice', 'shinyNew', { kind: 'change-form', oldPassword: 'rightOld' }),
  );
  assert(
    sugChange?.action === 'update' && sugChange.entryId === 'b',
    'change-form picks entry matching oldPassword',
  );

  const sugChangeFallback = decideSuggestionFromComparisons(
    [
      mkCompared('a', 'alice'),
      mkCompared('b', 'alice'),
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

  // --- browser CSV import (parser + mapper) ---
  // Quoted fields, comma inside a quoted password, escaped quote, CRLF.
  const csvParsed = parseCsv(
    'name,url,username,password,note\r\n' +
      'GitHub,https://github.com,alice,"p,a""ss",hi\r\n' +
      'Example,https://example.com,bob,secret,\r\n',
  );
  assert(csvParsed.length === 3, 'parseCsv returns header + 2 rows');
  assert(csvParsed[1]![3] === 'p,a"ss', 'parseCsv handles comma + escaped quote in field');

  const chrome = csvToEntries('name,url,username,password,note\nMy Site,https://site.com,u1,pw1,n1\n');
  assert(chrome.entries.length === 1, 'Chrome CSV maps one entry');
  assert(
    chrome.entries[0]!.title === 'My Site' &&
      chrome.entries[0]!.url === 'https://site.com' &&
      chrome.entries[0]!.username === 'u1' &&
      chrome.entries[0]!.password === 'pw1' &&
      chrome.entries[0]!.notes === 'n1',
    'Chrome CSV maps all columns',
  );

  // Firefox-style header (no name column) → title falls back to host.
  const firefox = csvToEntries('"url","username","password"\n"https://www.mail.com/login","carol","pw2"\n');
  assert(firefox.entries[0]!.title === 'mail.com', 'Firefox CSV falls back title to host (www stripped)');

  await rejects(
    async () => csvToEntries('foo,bar\n1,2\n'),
    'CSV without username/password column is rejected',
  );

  // Bulk add + dedup through the engine, persisted and reopened.
  await VaultEngine.open(reKeyed, PW);
  const before = VaultEngine.listEntries().length;
  const bulk = VaultEngine.addEntries([
    { title: 'Bulk A', username: 'ba', password: 'p1', url: 'https://a.com', notes: '' },
    { title: 'Bulk B', username: 'bb', password: 'p2', url: 'https://b.com', notes: '' },
    { title: 'Bulk A dup', username: 'ba', password: 'p1', url: 'https://a.com/', notes: '' },
  ]);
  assert(bulk.added === 2 && bulk.skipped === 1, 'addEntries dedups URL+username (trailing slash ignored)');
  assert(VaultEngine.listEntries().length === before + 2, 'two new entries present after bulk add');
  const bulkSaved = await VaultEngine.save();
  await VaultEngine.open(bulkSaved, PW);
  assert(
    VaultEngine.listEntries().some((e) => e.title === 'Bulk A'),
    'bulk-added entries persist across save/open',
  );

  // --- P0-5: password comparison stays inside offscreen/VaultEngine ---
  const comparePrimary = VaultEngine.addEntry({
    title: 'Compare Primary',
    username: 'compare-user',
    password: 'compare-old-one',
    url: 'https://compare.example/login',
    notes: '',
  });
  const compareSecondary = VaultEngine.addEntry({
    title: 'Compare Secondary',
    username: 'compare-user',
    password: 'compare-old-two',
    url: 'https://compare.example/account',
    notes: '',
  });
  const compareGetTextBefore = getProtectedValueGetTextCount();
  const unchanged = VaultEngine.preparePendingSuggestion({
    url: 'https://compare.example/login',
    username: 'compare-user',
    password: 'compare-old-one',
    kind: 'submit',
  });
  assert(unchanged === null, 'offscreen comparison silently ignores an unchanged password');

  const preparedUpdate = VaultEngine.preparePendingSuggestion({
    url: 'https://compare.example/settings',
    username: 'compare-user',
    password: 'compare-new',
    oldPassword: 'compare-old-two',
    kind: 'change-form',
  });
  assert(
    preparedUpdate?.suggestion.action === 'update' &&
      preparedUpdate.suggestion.entryId === compareSecondary.id,
    'offscreen comparison selects the entry matching the old password',
  );
  assert(
    preparedUpdate != null && !('newPassword' in preparedUpdate.suggestion),
    'preparePending returns no password plaintext in suggestion metadata',
  );
  VaultEngine.clearPendingSecret();

  const preparedSave = VaultEngine.preparePendingSuggestion({
    url: 'https://compare.example/register',
    username: 'new-compare-user',
    password: 'compare-new-account',
    kind: 'submit',
  });
  assert(
    preparedSave?.suggestion.action === 'save' &&
      preparedSave.suggestion.entryId === undefined,
    'offscreen comparison proposes save for a new username',
  );
  VaultEngine.clearPendingSecret();
  assert(
    getProtectedValueGetTextCount() === compareGetTextBefore,
    'offscreen password comparison never materializes stored passwords as JS strings',
  );
  assert(
    comparePrimary.id !== compareSecondary.id,
    'comparison fixtures use distinct entries',
  );

  // --- P0-5: pending secret token lifecycle ---
  const token = VaultEngine.storePendingSecret('captured-pw-123');
  assert(typeof token === 'string' && token.length > 0, 'storePendingSecret returns a non-empty token');
  const savedEntry = VaultEngine.applyPendingSecret(token, {
    action: 'save',
    title: 'Pending Site',
    username: 'pending-user',
    url: 'https://pending.example.com/',
  });
  assert(savedEntry.hasPassword === true, 'applyPendingSecret(save) creates an entry with password');
  assert(
    VaultEngine.getEntry(savedEntry.id, true).password === 'captured-pw-123',
    'pending secret password is stored correctly',
  );
  const retriedEntry = VaultEngine.applyPendingSecret(token, {
    action: 'save',
    title: 'ignored on retry',
    username: 'ignored',
    url: 'https://ignored.example/',
  });
  assert(retriedEntry.id === savedEntry.id, 'pending apply is idempotent until persistence commits');
  VaultEngine.commitPendingSecret(token);
  await rejects(
    async () => {
      VaultEngine.applyPendingSecret(token, {
        action: 'save',
        title: 'x',
        username: 'y',
        url: 'z',
      });
    },
    'committed pending token cannot be reused',
  );

  const beforeAddRollback = VaultEngine.listEntries().length;
  const rollbackToken = VaultEngine.storePendingSecret('rollback-add-pw');
  const rollbackEntry = VaultEngine.applyPendingSecret(rollbackToken, {
    action: 'save',
    title: 'Must Roll Back',
    username: 'rollback-user',
    url: 'https://rollback.example/',
  });
  assert(
    VaultEngine.listEntries().length === beforeAddRollback + 1,
    'pending save is visible before rollback',
  );
  VaultEngine.rollbackPendingSecret(rollbackToken);
  assert(
    VaultEngine.listEntries().length === beforeAddRollback,
    'rollbackPendingSecret removes an uncommitted new entry',
  );
  const reappliedEntry = VaultEngine.applyPendingSecret(rollbackToken, {
    action: 'save',
    title: 'Retry After Rollback',
    username: 'rollback-user',
    url: 'https://rollback.example/',
  });
  assert(
    reappliedEntry.id !== rollbackEntry.id &&
      VaultEngine.listEntries().length === beforeAddRollback + 1,
    'rolled-back pending save can be retried exactly once',
  );
  VaultEngine.rollbackPendingSecret(rollbackToken);
  VaultEngine.clearPendingSecret();

  const originalPassword = VaultEngine.getEntry(savedEntry.id, true).password;
  const updateToken = VaultEngine.storePendingSecret('rollback-update-pw');
  VaultEngine.applyPendingSecret(updateToken, {
    action: 'update',
    entryId: savedEntry.id,
  });
  assert(
    VaultEngine.getEntry(savedEntry.id, true).password === 'rollback-update-pw',
    'pending update is visible before rollback',
  );
  VaultEngine.rollbackPendingSecret(updateToken);
  assert(
    VaultEngine.getEntry(savedEntry.id, true).password === originalPassword,
    'rollbackPendingSecret restores the original password',
  );
  VaultEngine.applyPendingSecret(updateToken, {
    action: 'update',
    entryId: savedEntry.id,
  });
  VaultEngine.rollbackPendingSecret(updateToken);
  VaultEngine.clearPendingSecret();
  const rollbackSaved = await VaultEngine.save();
  await VaultEngine.open(rollbackSaved, PW);
  assert(
    VaultEngine.getEntry(savedEntry.id, true).password === originalPassword,
    'rolled-back update stays absent after save and reopen',
  );

  // clearPendingSecret rolls back an applied save and invalidates the token.
  const beforeClear = VaultEngine.listEntries().length;
  const token2 = VaultEngine.storePendingSecret('temp-pw');
  VaultEngine.applyPendingSecret(token2, {
    action: 'save',
    title: 'Clear Must Roll Back',
    username: 'clear-user',
    url: 'https://clear.example/',
  });
  VaultEngine.clearPendingSecret();
  assert(
    VaultEngine.listEntries().length === beforeClear,
    'clearPendingSecret rolls back an applied new entry',
  );
  await rejects(
    async () => {
      VaultEngine.applyPendingSecret(token2, {
        action: 'save',
        title: 'x',
        username: 'y',
        url: 'z',
      });
    },
    'clearPendingSecret invalidates the token',
  );
  // lock() also rolls back and clears pending secret.
  const beforeLock = VaultEngine.listEntries().length;
  const token3 = VaultEngine.storePendingSecret('before-lock');
  VaultEngine.applyPendingSecret(token3, {
    action: 'save',
    title: 'Lock Must Roll Back',
    username: 'lock-user',
    url: 'https://lock.example/',
  });
  VaultEngine.lock();
  await rejects(
    async () => {
      VaultEngine.applyPendingSecret(token3, {
        action: 'save',
        title: 'x',
        username: 'y',
        url: 'z',
      });
    },
    'lock() rolls back and clears pending secret',
  );
  await VaultEngine.open(rollbackSaved, PW);
  assert(
    VaultEngine.listEntries().length === beforeLock &&
      !VaultEngine.listEntries().some((entry) => entry.title === 'Lock Must Roll Back'),
    'lock rollback remains absent after reopen',
  );
  // --- end P0-5 ---

  // --- 解锁失败阶梯式锁定策略（参考小米手机，缩放适配浏览器）---
  assert(
    lockdownDurationFor(0) === 0 && lockdownDurationFor(4) === 0,
    '1-4 次失败不锁定',
  );
  assert(lockdownDurationFor(5) === 30_000, '第 5 次失败锁定 30 秒');
  assert(lockdownDurationFor(6) === 60_000, '第 6 次失败锁定 1 分钟');
  assert(lockdownDurationFor(7) === 300_000, '第 7 次失败锁定 5 分钟');
  assert(lockdownDurationFor(8) === 900_000, '第 8 次失败锁定 15 分钟');
  assert(lockdownDurationFor(9) === 1_800_000, '第 9 次失败锁定 30 分钟');
  assert(
    lockdownDurationFor(100) === 1_800_000,
    '第 100 次失败仍为 30 分钟上限',
  );
  assert(LOCKDOWN_THRESHOLD === 5, '锁定阈值为第 5 次');

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
