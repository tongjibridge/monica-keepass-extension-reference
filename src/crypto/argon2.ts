import { CryptoEngine } from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

// kdbxweb does not bundle an Argon2 implementation; the caller must provide one.
// kdbxweb passes `memory` already converted to KiB (it computes M / 1024), which
// matches hash-wasm's `memorySize` unit. hash-wasm always uses Argon2 v0x13.

let installed = false;

// Session memoization. kdbxweb re-runs the KDF on every save, but when the vault
// engine freezes the Argon2 salt for the session (see vault/engine.ts), the
// inputs are identical across saves - so the expensive transform only runs once.
// Security: the cached value is just the KDF transform key; the final cipher key
// still mixes a fresh masterSeed per save, so this never reuses a keystream.
// The cache holds at most one entry and is cleared on lock.
//
// P0-2: the cache key is a SHA-256 digest over all KDF inputs (not a plaintext
// string), stored as a fillable Uint8Array so it can be zeroed on lock. The
// cache value is also a Uint8Array and is fill(0)-ed before the reference is
// dropped.
let cacheKey: Uint8Array | null = null;
let cacheValue: Uint8Array | null = null;

// Diagnostic: number of real Argon2 computations (cache misses). Used by tests
// to verify saves reuse the cached transform key.
let computeCount = 0;
export function argon2ComputeCount(): number {
  return computeCount;
}

/** Encode a uint32 as 4 little-endian bytes (fillable). */
function uint32Bytes(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** SHA-256 over all KDF inputs, returned as a fillable Uint8Array. */
async function digestCacheKey(
  pw: Uint8Array,
  slt: Uint8Array,
  memory: number,
  iterations: number,
  length: number,
  parallelism: number,
  type: number,
  version: number,
): Promise<Uint8Array> {
  const parts = [
    pw,
    slt,
    uint32Bytes(memory),
    uint32Bytes(iterations),
    uint32Bytes(length),
    uint32Bytes(parallelism),
    uint32Bytes(type),
    uint32Bytes(version),
  ];
  const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const hash = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  // Zero the concatenated buffer - it contains password bytes.
  buf.fill(0);
  return new Uint8Array(hash);
}

/** Constant-time-ish byte comparison for two equal-length digests. */
function keyMatches(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function clearArgon2Cache(): void {
  cacheKey?.fill(0);
  cacheValue?.fill(0);
  cacheKey = null;
  cacheValue = null;
}

export function installArgon2(): void {
  if (installed) return;
  CryptoEngine.setArgon2Impl(
    async (
      password: ArrayBuffer,
      salt: ArrayBuffer,
      memory: number,
      iterations: number,
      length: number,
      parallelism: number,
      type: number,
      version: number,
    ): Promise<ArrayBuffer> => {
      const pw = new Uint8Array(password);
      const slt = new Uint8Array(salt);
      const key = await digestCacheKey(
        pw,
        slt,
        memory,
        iterations,
        length,
        parallelism,
        type,
        version,
      );

      if (cacheKey && keyMatches(cacheKey, key) && cacheValue) {
        // Cache hit - discard the freshly computed digest and return a copy.
        key.fill(0);
        return cacheValue.slice(0).buffer as ArrayBuffer;
      }

      computeCount++;
      const params = {
        password: pw,
        salt: slt,
        parallelism,
        iterations,
        memorySize: memory,
        hashLength: length,
        outputType: 'binary' as const,
      };
      const hash =
        type === CryptoEngine.Argon2TypeArgon2id
          ? await argon2id(params)
          : await argon2d(params);
      const out = new Uint8Array(
        hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength),
      );

      // Overwrite old cache before replacing.
      cacheKey?.fill(0);
      cacheValue?.fill(0);
      cacheKey = key;
      cacheValue = out;
      return out.slice(0).buffer as ArrayBuffer;
    },
  );
  installed = true;
}
