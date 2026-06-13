import { VaultEngine } from '@/src/vault/engine';
import {
  base64ToBytes,
  bytesToBase64,
  type OffscreenEnvelope,
  type OffscreenOp,
} from '@/src/messaging/protocol';

async function handle(op: OffscreenOp): Promise<unknown> {
  switch (op.op) {
    case 'open':
      return VaultEngine.open(
        base64ToBytes(op.data).buffer as ArrayBuffer,
        op.password,
        op.keyFile ? (base64ToBytes(op.keyFile).buffer as ArrayBuffer) : undefined,
      );
    case 'createNew':
      return bytesToBase64(await VaultEngine.createNew(op.name, op.password));
    case 'lock':
      VaultEngine.lock();
      return null;
    case 'status':
      return { unlocked: VaultEngine.isUnlocked() };
    case 'meta':
      return VaultEngine.getMeta();
    case 'listGroups':
      return VaultEngine.listGroups();
    case 'listEntries':
      return VaultEngine.listEntries();
    case 'getEntry':
      return VaultEngine.getEntry(op.id, op.reveal);
    case 'add':
      return VaultEngine.addEntry(op.input);
    case 'update':
      return VaultEngine.updateEntry(op.input);
    case 'delete':
      VaultEngine.deleteEntry(op.id);
      return null;
    case 'save':
      return bytesToBase64(await VaultEngine.save());
    case 'kdfInfo':
      return VaultEngine.getKdfInfo();
    case 'setKdf':
      return VaultEngine.setKdfProfile(op.profile);
    case 'mergeRemote':
      return bytesToBase64(
        await VaultEngine.mergeRemote(
          base64ToBytes(op.data).buffer as ArrayBuffer,
          op.password,
          op.keyFile ? (base64ToBytes(op.keyFile).buffer as ArrayBuffer) : undefined,
        ),
      );
  }
}

chrome.runtime.onMessage.addListener(
  (msg: OffscreenEnvelope, _sender, sendResponse: (r: unknown) => void) => {
    if (!msg || msg.target !== 'offscreen') return undefined;
    handle(msg.payload).then(
      (value) => sendResponse({ ok: true, value }),
      (err: unknown) => sendResponse({ ok: false, error: errorMessage(err) }),
    );
    return true; // keep the channel open for the async response
  },
);

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
