// Strong random password/passphrase generation using the Web Crypto CSPRNG.
// All selection uses rejection sampling to avoid modulo bias.

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?';
// Characters that are easy to confuse visually.
const AMBIGUOUS = new Set('il1Lo0O|`\'"');

/** Returns an unbiased integer in [0, maxExclusive). */
function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error('maxExclusive must be > 0');
  // Largest multiple of maxExclusive that fits in a uint32, used as a
  // rejection threshold so every residue class is equally likely.
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % maxExclusive;
}

function pick(chars: string): string {
  return chars[secureRandomInt(chars.length)]!;
}

/** In-place Fisher-Yates shuffle using the CSPRNG. */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

function filterAmbiguous(chars: string): string {
  return [...chars].filter((c) => !AMBIGUOUS.has(c)).join('');
}

interface BuiltPool {
  pool: string;
  required: string[];
}

function buildPool(opts: PasswordOptions): BuiltPool {
  const classes: string[] = [];
  if (opts.lowercase) classes.push(LOWER);
  if (opts.uppercase) classes.push(UPPER);
  if (opts.digits) classes.push(DIGITS);
  if (opts.symbols) classes.push(SYMBOLS);

  const cleaned = classes
    .map((c) => (opts.excludeAmbiguous ? filterAmbiguous(c) : c))
    .filter((c) => c.length > 0);

  if (cleaned.length === 0) {
    throw new Error('At least one character class must be enabled');
  }
  return {
    pool: cleaned.join(''),
    // One guaranteed character per enabled class.
    required: cleaned.map((c) => pick(c)),
  };
}

export function generatePassword(opts: PasswordOptions): string {
  const { pool, required } = buildPool(opts);
  const length = Math.max(opts.length, required.length);

  const chars: string[] = [...required];
  while (chars.length < length) {
    chars.push(pick(pool));
  }
  shuffle(chars);
  return chars.join('');
}

/** Shannon entropy in bits, assuming uniform selection over the pool. */
export function estimateEntropyBits(opts: PasswordOptions): number {
  const { pool } = buildPool(opts);
  const length = Math.max(opts.length, 1);
  return Math.round(length * Math.log2(pool.length));
}

export type StrengthLabel = 'weak' | 'fair' | 'good' | 'strong';

export function strengthFromEntropy(bits: number): StrengthLabel {
  if (bits < 50) return 'weak';
  if (bits < 75) return 'fair';
  if (bits < 100) return 'good';
  return 'strong';
}
