import { CryptoEngine } from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

// kdbxweb does not bundle an Argon2 implementation; the caller must provide one.
// kdbxweb passes `memory` already converted to KiB (it computes M / 1024), which
// matches hash-wasm's `memorySize` unit. hash-wasm always uses Argon2 v0x13.

let installed = false;

// Session memoization. kdbxweb re-runs the KDF on every save, but when the vault
// engine freezes the Argon2 salt for the session (see vault/engine.ts), the
// inputs are identical across saves — so the expensive transform only runs once.
// Security: the cached value is just the KDF transform key; the final cipher key
// still mixes a fresh masterSeed per save, so this never reuses a keystream.
// The cache holds at most one entry and is cleared on lock.
let cacheKey: string | null = null;
let cacheValue: ArrayBuffer | null = null;

// Diagnostic: number of real Argon2 computations (cache misses). Used by tests
// to verify saves reuse the cached transform key.
let computeCount = 0;
export function argon2ComputeCount(): number {
  return computeCount;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function clearArgon2Cache(): void {
  cacheKey = null;
  cacheValue = null;
}

export function installArgon2(): void {
  if (installed) return;
  CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type) => {
      const pw = new Uint8Array(password);
      const slt = new Uint8Array(salt);
      const key = `${toBase64(pw)}|${toBase64(slt)}|${memory}|${iterations}|${length}|${parallelism}|${type}`;
      if (cacheKey === key && cacheValue) {
        return cacheValue.slice(0);
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
      const out = hash.buffer.slice(
        hash.byteOffset,
        hash.byteOffset + hash.byteLength,
      ) as ArrayBuffer;
      cacheKey = key;
      cacheValue = out;
      return out.slice(0);
    },
  );
  installed = true;
}
