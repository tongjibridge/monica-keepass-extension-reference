// Integration check of the chrome-free business logic, bundled the same way the
// extension is (esbuild), so kdbxweb's CJS named-import interop is exercised too.
import { VaultEngine } from '@/src/vault/engine';
import { matchEntriesForUrl } from '@/src/autofill/match';
import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateEntropyBits,
  generatePassword,
} from '@/src/crypto/generator';

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

  console.log(`\nALL ${passed} HARNESS CHECKS PASSED`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
