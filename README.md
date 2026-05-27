<h1 align="center">Monica KeePass Browser Extension</h1>

<div align="center">

[中文](README.zh-CN.md) | **English**

<img src="public/icons/icon-128.png" alt="Monica KeePass icon" width="96" />

<p><strong>Local-first KeePass vault for Chrome and Edge</strong></p>
<p>Browser Extension · KeePass · Windows Hello · OneDrive Sync</p>

</div>

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
pnpm run zip
```

## GitHub Actions Packaging

The repository includes `.github/workflows/build-extension.yml`.

- Every push to `main` and every pull request runs type-checking, harness tests,
  and `pnpm run zip`.
- The zipped extension is uploaded as a workflow artifact named
  `monica-keepass-extension-chrome`.
- Pushing a version tag such as `v0.1.0` also creates a GitHub Release and
  attaches the generated `.zip`.

To publish a release:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## Notes

This repository is a browser-extension reference build. The Android app and the
browser extension do not share runtime storage, but the OneDrive KeePass sync
flow follows the Android-side design: Graph file metadata is checked with ETag
or cTag, local state keeps a base hash, and conflict cases avoid overwriting the
remote vault blindly.

## License

This project is released under the GNU General Public License v3.0 only
(`GPL-3.0-only`), matching the license used by the Monica Android reference
project. See [LICENSE](LICENSE) for the full text.

## Star History

<a href="https://www.star-history.com/?repos=tongjibridge%2Fmonica-keepass-extension-reference&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tongjibridge/monica-keepass-extension-reference&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=tongjibridge/monica-keepass-extension-reference&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=tongjibridge/monica-keepass-extension-reference&type=date&legend=top-left" />
 </picture>
</a>

## Acknowledgements

Thanks to the Monica Android project for the reference implementation and
product direction:

- Monica for Android: https://github.com/JoyinJoester/Monica

This extension also builds on the KeePass ecosystem and `kdbxweb` for `.kdbx`
read/write and merge support.
