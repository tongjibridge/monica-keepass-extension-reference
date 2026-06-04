import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const outputDir = '.output';
const artifactDir = 'artifacts';
const zipPath = process.argv[2] ?? findChromeZip(outputDir);
const privateKeyPem = loadPrivateKeyPem();

if (!zipPath) {
  throw new Error('No Chrome extension zip found. Run `pnpm run zip` first.');
}

if (!privateKeyPem && process.env.CRX_ALLOW_EPHEMERAL !== '1') {
  throw new Error(
    'CRX private key is required. Set CRX_PRIVATE_KEY_BASE64 or CRX_PRIVATE_KEY, ' +
      'or set CRX_ALLOW_EPHEMERAL=1 for non-release test builds.',
  );
}

const privateKey = privateKeyPem
  ? createPrivateKey(privateKeyPem)
  : generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
const signedData = message([fieldBytes(1, crxId)]);
const zip = readFileSync(zipPath);
const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), signedData, zip]), privateKey);
const header = message([
  fieldMessage(2, message([fieldBytes(1, publicKeyDer), fieldBytes(2, signature)])),
  fieldMessage(10000, signedData),
]);

mkdirSync(artifactDir, { recursive: true });
const crxPath = join(artifactDir, basename(zipPath).replace(/\.zip$/i, '.crx'));
writeFileSync(
  crxPath,
  Buffer.concat([
    Buffer.from('Cr24'),
    uint32(3),
    uint32(header.length),
    header,
    zip,
  ]),
);

if (!privateKeyPem) {
  console.warn('Built CRX with an ephemeral key. Do not use this build as a stable release.');
}
console.log(`Built ${crxPath}`);
console.log(`Chrome extension ID: ${extensionId(crxId)}`);

function findChromeZip(dir) {
  if (!existsSync(dir)) return null;
  const zips = readdirSync(dir)
    .filter((name) => /-chrome\.zip$/i.test(name))
    .sort();
  return zips.length ? join(dir, zips[zips.length - 1]) : null;
}

function loadPrivateKeyPem() {
  if (process.env.CRX_PRIVATE_KEY_BASE64) {
    return Buffer.from(process.env.CRX_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  }
  return process.env.CRX_PRIVATE_KEY || '';
}

function extensionId(bytes) {
  const alphabet = 'abcdefghijklmnop';
  return [...bytes]
    .map((byte) => alphabet[byte >> 4] + alphabet[byte & 0x0f])
    .join('');
}

function message(fields) {
  return Buffer.concat(fields);
}

function fieldBytes(fieldNumber, value) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(value.length), value]);
}

function fieldMessage(fieldNumber, value) {
  return fieldBytes(fieldNumber, value);
}

function varint(value) {
  const bytes = [];
  let n = value;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function uint32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}
