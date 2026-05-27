import { callBackground } from '@/src/messaging/protocol';
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from '@/src/crypto/generator';
import type { EntrySummary } from '@/src/vault/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    new Autofiller().init();
  },
});

const USERNAME_SELECTOR =
  'input[type=text], input[type=email], input[type=tel], input:not([type])';
const CONTROL_SIZE = 28;
const CONTROL_GAP = 4;

type ControlIcon = 'vault' | 'spark';

function isFillField(el: HTMLInputElement): boolean {
  return el.type === 'password' || el.matches(USERNAME_SELECTOR);
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

class Autofiller {
  private menu: HTMLDivElement | null = null;
  private controls: HTMLDivElement | null = null;
  private activeField: HTMLInputElement | null = null;
  private controlField: HTMLInputElement | null = null;

  init() {
    document.addEventListener('focusin', this.onFocus, true);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('scroll', this.updateControlsPosition, true);
    window.addEventListener('resize', this.updateControlsPosition);
  }

  private onFocus = (e: Event) => {
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLInputElement)) return;
    if (!isFillField(el)) return;
    this.activeField = el;
    this.showControlsFor(el);
  };

  private onDocPointerDown = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (!target) return;
    if (this.menu?.contains(target)) return;
    if (this.controls?.contains(target)) return;
    if (target instanceof HTMLInputElement && isFillField(target)) {
      if (target !== this.activeField) this.closeMenu();
      return;
    }
    this.closeMenu();
    this.closeControls();
  };

  private showControlsFor(field: HTMLInputElement) {
    this.controlField = field;
    if (!this.controls) {
      const controls = document.createElement('div');
      controls.setAttribute('data-monica-autofill-controls', '');
      Object.assign(controls.style, {
        position: 'absolute',
        display: 'flex',
        gap: `${CONTROL_GAP}px`,
        zIndex: '2147483647',
        font: '13px system-ui, sans-serif',
      } satisfies Partial<CSSStyleDeclaration>);

      const fillButton = this.createControlButton('vault', 'Search Monica KeePass accounts');
      fillButton.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const targetField = this.controlField;
        if (!targetField) return;
        this.activeField = targetField;
        void this.showAccountPicker(targetField);
      });
      controls.appendChild(fillButton);

      document.body.appendChild(controls);
      this.controls = controls;
    }

    this.syncGenerateButton(field);
    this.updateControlsPosition();
  }

  private createControlButton(icon: ControlIcon, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = controlIconSvg(icon);
    button.title = title;
    button.setAttribute('aria-label', title);
    Object.assign(button.style, {
      width: `${CONTROL_SIZE}px`,
      height: `${CONTROL_SIZE}px`,
      border: '1px solid #d7dce5',
      borderRadius: '999px',
      background: '#ffffff',
      color: '#1f2937',
      boxShadow: '0 4px 14px rgba(16,24,40,0.18)',
      cursor: 'pointer',
      padding: '0',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    } satisfies Partial<CSSStyleDeclaration>);
    button.addEventListener('mouseenter', () => {
      button.style.background = '#eef4ff';
      button.style.borderColor = '#91b4ff';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = '#ffffff';
      button.style.borderColor = '#d7dce5';
    });
    return button;
  }

  private syncGenerateButton(field: HTMLInputElement) {
    if (!this.controls) return;
    const existing = this.controls.querySelector<HTMLButtonElement>('[data-monica-generate]');
    if (field.type !== 'password') {
      existing?.remove();
      return;
    }
    if (existing) return;

    const generateButton = this.createControlButton('spark', 'Generate strong password');
    generateButton.setAttribute('data-monica-generate', '');
    generateButton.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const targetField = this.controlField;
      if (!targetField || targetField.type !== 'password') return;
      const password = generatePassword(DEFAULT_PASSWORD_OPTIONS);
      setNativeValue(targetField, password);
      targetField.focus();
      targetField.select();
      this.closeMenu();
      this.updateControlsPosition();
    });
    this.controls.appendChild(generateButton);
  }

  private updateControlsPosition = () => {
    const field = this.controlField;
    if (!this.controls || !field || !document.contains(field)) {
      this.closeControls();
      return;
    }

    const rect = field.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.closeControls();
      return;
    }

    const controlsWidth = this.controls.offsetWidth || CONTROL_SIZE;
    const outsideLeft = rect.right + window.scrollX + CONTROL_GAP;
    const outsideFits = rect.right + controlsWidth + CONTROL_GAP + 8 <= window.innerWidth;
    const left = outsideFits
      ? outsideLeft
      : rect.right + window.scrollX - controlsWidth - CONTROL_GAP;
    const top = rect.top + window.scrollY + Math.max((rect.height - CONTROL_SIZE) / 2, 0);

    this.controls.style.left = `${Math.max(window.scrollX + 4, left)}px`;
    this.controls.style.top = `${top}px`;
  };

  private async showAccountPicker(field: HTMLInputElement) {
    this.closeMenu();
    const rect = field.getBoundingClientRect();
    const menu = this.createMenu(rect);
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search accounts';
    search.setAttribute('aria-label', 'Search accounts');
    Object.assign(search.style, {
      width: '100%',
      boxSizing: 'border-box',
      margin: '0 0 6px 0',
      padding: '8px 10px',
      border: '1px solid #d7dce5',
      borderRadius: '7px',
      outline: 'none',
      font: '13px system-ui, sans-serif',
    } satisfies Partial<CSSStyleDeclaration>);

    const list = document.createElement('div');
    Object.assign(list.style, {
      maxHeight: '230px',
      overflowY: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);

    menu.append(search, list);
    document.body.appendChild(menu);
    this.menu = menu;

    let entries: EntrySummary[] = [];
    try {
      entries = await this.loadPickerEntries();
    } catch {
      this.renderMessage(list, 'Unlock the vault to search accounts');
      search.disabled = true;
      return;
    }

    const render = () => this.renderAccountRows(list, field, filterEntries(entries, search.value));
    search.addEventListener('input', render);
    render();
    search.focus();
  }

  private createMenu(rect: DOMRect): HTMLDivElement {
    const menu = document.createElement('div');
    menu.setAttribute('data-monica-autofill', '');
    const width = Math.max(rect.width, 300);
    const left = Math.max(
      window.scrollX + 4,
      Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - width - 8),
    );
    Object.assign(menu.style, {
      position: 'absolute',
      top: `${rect.bottom + window.scrollY + 4}px`,
      left: `${left}px`,
      width: `${width}px`,
      maxWidth: `calc(100vw - 16px)`,
      boxSizing: 'border-box',
      background: '#ffffff',
      color: '#1f2329',
      border: '1px solid #e3e6eb',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(16,24,40,0.16)',
      zIndex: '2147483647',
      font: '14px system-ui, sans-serif',
      padding: '6px',
    } satisfies Partial<CSSStyleDeclaration>);
    return menu;
  }

  private async loadPickerEntries(): Promise<EntrySummary[]> {
    const [matches, entries] = await Promise.all([
      callBackground({ type: 'vault.match', url: location.href }).catch(() => [] as EntrySummary[]),
      callBackground({ type: 'vault.listEntries' }),
    ]);

    const ordered = new Map<string, EntrySummary>();
    for (const entry of matches) ordered.set(entry.id, entry);
    for (const entry of entries) ordered.set(entry.id, entry);
    return [...ordered.values()];
  }

  private renderAccountRows(list: HTMLDivElement, field: HTMLInputElement, entries: EntrySummary[]) {
    list.replaceChildren();
    if (entries.length === 0) {
      this.renderMessage(list, 'No matching accounts');
      return;
    }

    for (const m of entries.slice(0, 50)) {
      const item = document.createElement('div');
      Object.assign(item.style, {
        padding: '9px 10px',
        cursor: 'pointer',
        borderRadius: '7px',
      } satisfies Partial<CSSStyleDeclaration>);
      item.innerHTML = `<div style="font-weight:600">${escapeHtml(
        m.title || '(untitled)',
      )}</div><div style="color:#6b7280;font-size:12px">${escapeHtml(m.username)}</div>`;
      item.addEventListener('mouseenter', () => (item.style.background = '#f0f4ff'));
      item.addEventListener('mouseleave', () => (item.style.background = 'transparent'));
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.fill(field, m.id);
      });
      list.appendChild(item);
    }
  }

  private renderMessage(list: HTMLDivElement, text: string) {
    const item = document.createElement('div');
    item.textContent = text;
    Object.assign(item.style, {
      padding: '10px',
      color: '#6b7280',
      fontSize: '13px',
    } satisfies Partial<CSSStyleDeclaration>);
    list.replaceChildren(item);
  }

  private async fill(field: HTMLInputElement, id: string) {
    try {
      const detail = await callBackground({ type: 'vault.getEntry', id, reveal: true });
      const { passwordField, usernameField } = locateFields(field);
      if (usernameField && detail.username) setNativeValue(usernameField, detail.username);
      if (passwordField && detail.password) setNativeValue(passwordField, detail.password);
    } catch {
      // ignore
    } finally {
      this.closeMenu();
    }
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  private closeControls() {
    this.controls?.remove();
    this.controls = null;
    this.controlField = null;
  }
}

function filterEntries(entries: EntrySummary[], query: string): EntrySummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) =>
    [entry.title, entry.username, entry.url]
      .some((value) => value.toLowerCase().includes(q)),
  );
}

function locateFields(field: HTMLInputElement): {
  passwordField: HTMLInputElement | null;
  usernameField: HTMLInputElement | null;
} {
  const form = field.form ?? document;
  const passwords = Array.from(
    form.querySelectorAll<HTMLInputElement>('input[type=password]'),
  );
  const passwordField = field.type === 'password' ? field : (passwords[0] ?? null);

  let usernameField: HTMLInputElement | null = null;
  if (field.type !== 'password') {
    usernameField = field;
  } else {
    const candidates = Array.from(form.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR));
    // Prefer the username-like field immediately before the password field.
    usernameField =
      candidates.filter((c) => c.compareDocumentPosition(passwordField ?? field) &
        Node.DOCUMENT_POSITION_FOLLOWING).pop() ?? candidates[0] ?? null;
  }
  return { passwordField, usernameField };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function controlIconSvg(icon: ControlIcon): string {
  if (icon === 'spark') {
    return `
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M14.6 4.6 16 2l1.4 2.6L20 6l-2.6 1.4L16 10l-1.4-2.6L12 6l2.6-1.4Z" fill="#2563eb"/>
        <path d="M5 14.5a4 4 0 1 1 6.9 2.8L9.2 20H6.8v-2.4l2.7-2.7A1.5 1.5 0 1 0 8 16.4l-1.8 1.8a4 4 0 0 1-1.2-3.7Z" fill="#0f172a"/>
        <path d="M13.5 13.5 20 20" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M18.8 20h2.4M20 18.8v2.4" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `;
  }

  return `
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3 19 6v5.7c0 5-3 7.9-7 9.3-4-1.4-7-4.3-7-9.3V6l7-3Z" fill="#2563eb"/>
      <path d="M9 12a3 3 0 1 1 4.7 2.5L16 17h-2.8l-1.3-1.4h-1.6l-1.1-1.1A3 3 0 0 1 9 12Z" fill="#ffffff"/>
      <path d="M12 11.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" fill="#2563eb"/>
    </svg>
  `;
}
