import { defineConfig } from 'wxt';

// WXT configuration. Docs: https://wxt.dev
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  manifest: {
    name: 'Monica KeePass',
    description:
      'KeePass-compatible password manager: Windows Hello unlock, autofill, password generation, OneDrive backup.',
    permissions: ['storage', 'offscreen', 'alarms', 'activeTab', 'scripting', 'identity'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Monica KeePass',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    // hash-wasm compiles Argon2 via WebAssembly; MV3's default CSP forbids it
    // without 'wasm-unsafe-eval'.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
