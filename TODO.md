# TODO: Practical Feature Roadmap

This list compares the current Monica KeePass browser extension with mature
ideas from KeePassXC-Browser and the KeePassXC documentation. It focuses on
features that would make daily browser password use more reliable, not on
copying KeePassXC-Browser's native-messaging architecture.

## References

- KeePassXC-Browser repository: https://github.com/keepassxreboot/keepassxc-browser
- KeePassXC-Browser README: https://github.com/keepassxreboot/keepassxc-browser/blob/develop/README.md
- KeePassXC-Browser manifest: https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-browser/manifest.json
- KeePassXC Browser Integration docs: https://keepassxc.org/docs/KeePassXC_UserGuide#_browser_integration

## Current Baseline

- Local KeePass `.kdbx` import/create/open/save.
- Master password/key-file unlock and optional Windows Hello unlock.
- Popup entry list, entry edit/delete, copy, password reveal, and generator.
- Content-script autofill matching by exact host, subdomain relation, base
  domain, multiple URL tokens, and URL stored in title.
- Field-side buttons for manual account search/fill and strong-password
  generation on password fields.
- OneDrive connect, browse `.kdbx`, pull, push, and ETag/hash-based sync with
  KeePass native merge where credentials are available.
- GitHub Actions build artifact and release packaging.

## P0 - High-Impact Daily Use

- [ ] Save new login after form submit.
  - Detect successful login or registration submit.
  - Prompt to save URL, username, and password into the current vault.
  - Avoid duplicate entries by matching URL + username.
  - Acceptance: after logging into a site with no matching entry, the extension
    offers to save credentials and the new entry appears in the popup.

- [ ] Update existing password after password change.
  - Detect old/new password forms and password reset flows.
  - Prompt to update the matched entry instead of creating a duplicate.
  - Preserve old password in KeePass entry history via existing update flow.
  - Acceptance: after changing a password, the extension offers to update the
    correct entry and the saved password works on the next login.

- [ ] Fill TOTP codes.
  - Detect OTP/TOTP fields and expose fill action near the field.
  - Add context-menu and popup actions for TOTP.
  - Respect reveal/secret handling so OTP secrets are not copied unnecessarily.
  - Acceptance: entries with `otp` can fill a six-digit code into common 2FA
    pages without revealing the password.

- [ ] Add context menus and keyboard shortcuts.
  - Add right-click actions for fill username+password, fill username, fill
    password, fill TOTP, generate password, save credentials, and redetect
    fields.
  - Add configurable commands similar to KeePassXC-Browser.
  - Acceptance: user can fill from the keyboard or context menu when the inline
    button fails or is hidden.

- [ ] Improve field detection for modern pages.
  - Support SPA route changes, delayed forms, shadow DOM where possible, and
    same-origin iframes.
  - Add a manual "redetect fields" command.
  - Prevent duplicate side buttons when DOM nodes are reused.
  - Acceptance: login forms that render after client-side navigation still show
    fill controls and match entries.

- [ ] OneDrive conflict review UI.
  - Replace text-only conflict copy result with a popup view listing local,
    remote, and conflict-copy paths.
  - Offer "unlock and merge", "keep local", "keep remote", and "open conflict
    copy info".
  - Acceptance: when both sides changed and credentials are unavailable, user
    gets a clear recovery path without reading logs or raw messages.

## P1 - Power User Features

- [ ] Per-site preferences.
  - Store site rules such as disabled autofill, exact-domain-only matching,
    preferred entry, auto-submit enabled/disabled, and ignored fields.
  - Keep settings local and exportable.
  - Acceptance: user can disable autofill on one site without disabling the
    whole extension.

- [ ] Custom field mapping.
  - Let the user choose username, password, TOTP, and additional string fields
    on a page.
  - Store mappings per origin/path.
  - Map extra fields to KeePass custom attributes, for example `KPH: Account`.
  - Acceptance: multi-field logins such as account ID + username + password can
    be filled reliably.

- [ ] HTTP Basic Auth support.
  - Use `webRequest.onAuthRequired`/MV3-compatible alternatives where possible.
  - Match credentials by request URL and fill auth dialogs.
  - Acceptance: sites using browser-native basic auth can be unlocked from the
    vault without manual copy/paste.

- [ ] Better notifications and status signals.
  - Show non-intrusive notifications for save/update success, locked vault,
    sync conflict, OneDrive token expiry, and field-detection failures.
  - Add badge/icon states for locked, unlocked, sync pending, and error.
  - Acceptance: user can tell why autofill did not happen without opening dev
    tools.

- [ ] Auto-submit with guardrails.
  - Optional per-site auto-submit after filling credentials.
  - Never auto-submit after generated-password insertion or on ambiguous
    multi-entry matches.
  - Acceptance: trusted sites can be filled and submitted in one command, while
    ambiguous pages still require confirmation.

- [ ] Entry selection ranking and pinning.
  - Let users pin a preferred entry for a domain.
  - Rank by exact host, last used entry, username match, title match, and
    explicit site preference.
  - Acceptance: sites with many entries show the expected account first.

- [ ] Clipboard safety.
  - When copy actions are used, clear copied secrets after a configurable delay.
  - Show countdown/status in popup.
  - Acceptance: copied password or TOTP is removed from clipboard after timeout
    unless user disables the option.

- [ ] Settings import/export.
  - Export extension settings, site preferences, and OneDrive config without
    exporting secrets or tokens.
  - Acceptance: user can reinstall the extension and restore preferences while
    still needing to reconnect/unlock sensitive material.

## P2 - Advanced / Larger Scope

- [ ] Passkey/WebAuthn support.
  - Evaluate feasibility of storing WebAuthn credentials/passkeys in KeePass
    entries or a compatible custom attribute format.
  - Support create/get mediation only after a dedicated security design.
  - Acceptance: passkey flows are behind an explicit experimental flag and do
    not interfere with platform authenticators.

- [ ] Default password manager integration.
  - Explore browser `privacy` settings and platform limitations for disabling
    the built-in password manager prompts.
  - Acceptance: user can opt into making the extension the preferred password
    manager where the browser allows it.

- [ ] Password health report.
  - Detect weak, reused, and old passwords locally.
  - Optional breach-check integration must be privacy-preserving and opt-in.
  - Acceptance: user can view a local report without sending vault contents to
    any service.

- [ ] Attachments and custom attributes editor.
  - Show and edit KeePass custom attributes beyond URL/user/password/notes/otp.
  - Allow attachment download/import where kdbxweb support is sufficient.
  - Acceptance: entries created in desktop KeePass clients do not lose advanced
    metadata when edited in the extension.

- [ ] Browser compatibility matrix.
  - Verify Chrome, Edge, Firefox MV3/MV2 constraints separately.
  - Document unsupported APIs such as basic auth or privacy settings per
    browser.
  - Acceptance: README has clear install/build notes for each supported
    browser.

- [ ] Managed deployment options.
  - Add documented enterprise policy defaults for settings that are safe to
    manage centrally.
  - Acceptance: organizations can preconfigure non-secret options such as
    disabled OneDrive, default auto-lock time, or allowed domains.

## Non-Goals For Now

- [ ] Do not add native messaging just to mimic KeePassXC-Browser. Monica
  KeePass currently owns the `.kdbx` file directly in the extension/offscreen
  runtime, so native messaging would add complexity without solving the main
  user problems.
- [ ] Do not auto-upload sync changes without visible status until conflict
  handling is clearer.
- [ ] Do not implement passkeys before a written security model exists.

## Suggested Implementation Order

1. Save/update credentials.
2. TOTP fill.
3. Context menus and keyboard shortcuts.
4. Field detection redetect + SPA/iframe hardening.
5. Per-site preferences and custom field mapping.
6. HTTP Basic Auth.
7. Conflict review UI for OneDrive.
8. Advanced features: passkeys, password health, attachments, managed policy.
