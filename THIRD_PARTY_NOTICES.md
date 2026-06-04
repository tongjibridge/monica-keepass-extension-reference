# Third-party Notices

Monica KeePass Browser Extension is released under `GPL-3.0-only`. It also uses
the following third-party open-source projects.

## Runtime Dependencies

| Project | License | Use |
| --- | --- | --- |
| [kdbxweb](https://github.com/keeweb/kdbxweb) | MIT | KeePass `.kdbx` read/write, save, and merge support. |
| [hash-wasm](https://github.com/Daninet/hash-wasm) | MIT | Argon2 and hashing primitives for KeePass KDF and encrypted backups. |
| [React](https://github.com/facebook/react) | MIT | Popup UI runtime. |
| [React DOM](https://github.com/facebook/react) | MIT | Popup UI rendering. |
| [Mantine](https://github.com/mantinedev/mantine) | MIT | Popup UI components and hooks. |
| [Tabler Icons](https://github.com/tabler/tabler-icons) | MIT | Icon set used in the popup and controls. |
| [tldts](https://github.com/remusao/tldts) | MIT | Domain parsing for URL matching. |

## Build And Development Dependencies

| Project | License | Use |
| --- | --- | --- |
| [WXT](https://github.com/wxt-dev/wxt) | MIT | Browser extension framework and build tooling. |
| [@wxt-dev/module-react](https://github.com/wxt-dev/wxt) | MIT | React integration for WXT. |
| [esbuild](https://github.com/evanw/esbuild) | MIT | Harness test bundling. |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Type checking and development tooling. |
| [@types/chrome](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Chrome extension API type definitions. |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | React type definitions. |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | React DOM type definitions. |

## Platform And Service APIs

These are platform or service APIs, not bundled open-source dependencies:

- Chrome Extension APIs
- WebAuthn / Windows Hello platform authenticator
- Web Crypto API
- Microsoft identity platform
- Microsoft Graph / OneDrive API

## Reference Project

This extension references product behavior and sync design from:

- [Monica for Android](https://github.com/JoyinJoester/Monica)
