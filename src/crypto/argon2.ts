import { CryptoEngine } from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

// kdbxweb does not bundle an Argon2 implementation; the caller must provide one.
// kdbxweb passes `memory` already converted to KiB (it computes M / 1024), which
// matches hash-wasm's `memorySize` unit. hash-wasm always uses Argon2 v0x13.

let installed = false;

export function installArgon2(): void {
  if (installed) return;
  CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type) => {
      const params = {
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
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
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
    },
  );
  installed = true;
}
