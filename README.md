# Monica KeePass Browser Extension

Monica KeePass is a local-first browser extension for working with KeePass `.kdbx`
vaults in Chrome and Edge. It focuses on keeping the encrypted vault on the
device while adding browser autofill, Windows Hello unlock, password generation,
and OneDrive backup/sync.

## Features

- Import or create KeePass-compatible `.kdbx` vaults.
- Unlock with a master password, key file, or remembered key file.
- Optional Windows Hello unlock after the vault has been enrolled locally.
- Browser autofill with improved URL matching for exact host, related
  subdomains, and same base-domain entries.
- Field-side controls for manual account search/fill.
- Strong password generation from the extension popup and password fields.
- OneDrive integration:
  - built-in Microsoft client ID;
  - connect directly from the settings page;
  - browse OneDrive folders and select a `.kdbx` vault for initialization;
  - pull remote updates, push local changes, or sync with KeePass-native merge.

## Install For Development

```powershell
pnpm install
pnpm run build
```

Then open `chrome://extensions/`, enable Developer mode, and load:

```text
extension/.output/chrome-mv3
```

## OneDrive Setup

The extension uses `chrome.identity.launchWebAuthFlow` with Microsoft identity
and Graph `Files.ReadWrite` access.

The Microsoft client ID is already built in:

```text
2113bcce-ee99-4703-b234-55fe2b3932da
```

The matching Microsoft app registration must include the extension redirect URI:

```text
https://<extension-id>.chromiumapp.org/onedrive
```

The current redirect URI is shown in the OneDrive section of the extension
settings page. After connecting, choose a `.kdbx` file from OneDrive to
initialize the local vault.

## Scripts

```powershell
pnpm run compile
pnpm run test:harness
pnpm run build
```

## Notes

This repository is a browser-extension reference build. The Android app and the
browser extension do not share runtime storage, but the OneDrive KeePass sync
flow follows the Android-side design: Graph file metadata is checked with ETag
or cTag, local state keeps a base hash, and conflict cases avoid overwriting the
remote vault blindly.

## Acknowledgements

Thanks to the Monica Android project for the reference implementation and
product direction:

- Monica for Android: https://github.com/JoyinJoester/Monica

This extension also builds on the KeePass ecosystem and `kdbxweb` for `.kdbx`
read/write and merge support.
