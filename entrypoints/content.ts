import {
  callBackground,
  type CredentialSnapshot,
  type PendingSuggestion,
} from '@/src/messaging/protocol';
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from '@/src/crypto/generator';
import type { EntrySummary } from '@/src/vault/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    new Autofiller().init();
    new CredentialCapture().init();
  },
});

const USERNAME_SELECTOR =
  'input[type=text], input[type=email], input[type=tel], input:not([type])';
const CONTROL_SIZE = 28;
const CONTROL_GAP = 4;

const CONTROL_DRAG_THRESHOLD = 4;
const CONTROLS_OFFSET_STORAGE_KEY = 'monica.controls.offset';

interface ControlsPosition {
  left: number;
  top: number;
}

interface ControlsOffset {
  dx: number;
  dy: number;
}

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
  private generator = new GeneratorPopover();
  private dragState: {
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null = null;

  init() {
    document.addEventListener('focusin', this.onFocus, true);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('scroll', this.updateControlsPosition, true);
    window.addEventListener('resize', this.onResize);
  }

  private onResize = () => {
    this.updateControlsPosition();
  };

  private offsetStorageKey(): string {
    const path = location.pathname || '/';
    return `${CONTROLS_OFFSET_STORAGE_KEY}.${location.origin}${path}`;
  }

  private loadOffset(): ControlsOffset | null {
    try {
      const raw = localStorage.getItem(this.offsetStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ControlsOffset>;
      if (typeof parsed.dx !== 'number' || typeof parsed.dy !== 'number') return null;
      return { dx: parsed.dx, dy: parsed.dy };
    } catch {
      return null;
    }
  }

  private saveOffset(offset: ControlsOffset) {
    try {
      localStorage.setItem(this.offsetStorageKey(), JSON.stringify(offset));
    } catch {
      // localStorage may be unavailable (private mode / sandbox); ignore.
    }
  }

  private clampPosition(pos: ControlsPosition | null): ControlsPosition | null {
    if (!pos) return null;
    const margin = 4;
    const width = this.controls?.offsetWidth || CONTROL_SIZE;
    const height = this.controls?.offsetHeight || CONTROL_SIZE;
    const viewLeft = margin;
    const viewTop = margin;
    const viewRight = window.innerWidth - margin;
    const viewBottom = window.innerHeight - margin;
    const left = clamp(pos.left, viewLeft, Math.max(viewLeft, viewRight - width));
    const top = clamp(pos.top, viewTop, Math.max(viewTop, viewBottom - height));
    return { left, top };
  }

  private applyPosition(pos: ControlsPosition) {
    if (!this.controls) return;
    this.controls.style.left = `${pos.left}px`;
    this.controls.style.top = `${pos.top}px`;
  }

  private onControlsPointerDown = (e: PointerEvent) => {
    if (!this.controls || e.button !== 0) return;
    const rect = this.controls.getBoundingClientRect();
    this.dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
    };
    document.addEventListener('pointermove', this.onControlsPointerMove, true);
    document.addEventListener('pointerup', this.onControlsPointerUp, true);
    document.addEventListener('pointercancel', this.onControlsPointerUp, true);
  };

  private onControlsPointerMove = (e: PointerEvent) => {
    if (!this.dragState || e.pointerId !== this.dragState.pointerId) return;
    const dx = e.clientX - this.dragState.startX;
    const dy = e.clientY - this.dragState.startY;
    if (!this.dragState.moved && Math.hypot(dx, dy) < CONTROL_DRAG_THRESHOLD) return;
    if (!this.dragState.moved) {
      this.dragState.moved = true;
      document.body.style.userSelect = 'none';
    }
    e.preventDefault();
    const next = this.clampPosition({
      left: this.dragState.originLeft + dx,
      top: this.dragState.originTop + dy,
    });
    if (next) this.applyPosition(next);
  };

  private onControlsPointerUp = (e: PointerEvent) => {
    const state = this.dragState;
    if (!state || e.pointerId !== state.pointerId) return;
    this.dragState = null;
    document.removeEventListener('pointermove', this.onControlsPointerMove, true);
    document.removeEventListener('pointerup', this.onControlsPointerUp, true);
    document.removeEventListener('pointercancel', this.onControlsPointerUp, true);
    document.body.style.userSelect = '';
    if (state.moved) {
      const rect = this.controls?.getBoundingClientRect();
      const base = this.defaultPositionForCurrentField();
      if (rect && base) {
        this.saveOffset({
          dx: rect.left - base.left,
          dy: rect.top - base.top,
        });
      }
      // Suppress the click that follows a drag so buttons don't fire.
      this.controls?.addEventListener(
        'click',
        (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
        },
        { capture: true, once: true },
      );
    }
  };

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
    if (this.generator.contains(target)) return;
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
        position: 'fixed',
        display: 'flex',
        gap: `${CONTROL_GAP}px`,
        zIndex: '2147483647',
        font: '13px system-ui, sans-serif',
      } satisfies Partial<CSSStyleDeclaration>);
      controls.addEventListener('pointerdown', this.onControlsPointerDown);

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
      this.closeMenu();
      this.generator.open(targetField);
    });
    this.controls.appendChild(generateButton);
  }

  private updateControlsPosition = () => {
    const field = this.controlField;
    if (!this.controls || !field || !document.contains(field)) {
      this.closeControls();
      return;
    }

    const next = this.positionForCurrentField();
    if (!next) {
      this.closeControls();
      return;
    }

    this.applyPosition(next);
  };

  private defaultPositionForCurrentField(): ControlsPosition | null {
    const field = this.controlField;
    if (!this.controls || !field || !document.contains(field)) return null;
    const rect = field.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    // Default placement: just to the right of the field, vertically centred.
    // (position:fixed means coordinates are viewport-relative, no scroll offset.)
    const controlsHeight = this.controls.offsetHeight || CONTROL_SIZE;
    const left = rect.right + CONTROL_GAP;
    const top = rect.top + Math.max((rect.height - controlsHeight) / 2, 0);
    return { left, top };
  }

  private positionForCurrentField(): ControlsPosition | null {
    const base = this.defaultPositionForCurrentField();
    if (!base) return null;
    const offset = this.loadOffset();
    const next = offset
      ? { left: base.left + offset.dx, top: base.top + offset.dy }
      : base;
    return this.clampPosition(next) ?? next;
  }

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

// Floating password generator. Lets the user pick a length (defaulting to the
// field's current length), preview the password, then copy + fill on demand.
class GeneratorPopover {
  private host: HTMLDivElement | null = null;
  private field: HTMLInputElement | null = null;
  private length = DEFAULT_PASSWORD_OPTIONS.length;
  private value = '';

  contains(node: Node | null): boolean {
    return !!node && !!this.host && this.host.contains(node);
  }

  open(field: HTMLInputElement) {
    this.close();
    this.field = field;
    this.length = clamp(field.value.length || DEFAULT_PASSWORD_OPTIONS.length, 8, 64);
    this.value = this.generate();

    const host = document.createElement('div');
    host.setAttribute('data-monica-generator', '');
    Object.assign(host.style, {
      position: 'fixed',
      width: '300px',
      maxWidth: 'calc(100vw - 24px)',
      boxSizing: 'border-box',
      background: '#ffffff',
      color: '#1f2329',
      border: '1px solid #e3e6eb',
      borderRadius: '12px',
      boxShadow: '0 12px 32px rgba(16,24,40,0.22)',
      zIndex: '2147483647',
      padding: '14px',
      font: '14px system-ui, -apple-system, "Segoe UI", sans-serif',
    } satisfies Partial<CSSStyleDeclaration>);

    host.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="font-weight:600">Generate password</span>
        <button data-act="close" aria-label="Close" style="border:none;background:none;cursor:pointer;color:#9aa3b2;padding:2px;line-height:0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6 6 18M6 6l12 12" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div data-out style="margin-top:10px;padding:10px;border:1px solid #e3e6eb;border-radius:8px;background:#f7f8fa;font-family:ui-monospace,'Cascadia Code',monospace;font-size:13px;word-break:break-all;user-select:all"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px">
        <span style="color:#6b7280;font-size:12px">Length</span>
        <span data-len style="font-weight:600"></span>
      </div>
      <input data-range type="range" min="8" max="64" style="width:100%;margin-top:6px;accent-color:#4f46e5" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button data-act="regen" style="cursor:pointer;border:1px solid #e3e6eb;background:#fff;color:#1f2329;border-radius:8px;padding:7px 12px;font:inherit;font-weight:550">Regenerate</button>
        <button data-act="fill" style="cursor:pointer;border:1px solid #4f46e5;background:#4f46e5;color:#fff;border-radius:8px;padding:7px 14px;font:inherit;font-weight:550">Fill</button>
      </div>
    `;

    host.addEventListener('click', (e) => e.stopPropagation());
    const range = host.querySelector<HTMLInputElement>('[data-range]')!;
    range.value = String(this.length);
    range.addEventListener('input', () => {
      this.length = Number(range.value);
      this.value = this.generate();
      this.render();
    });
    host.querySelector('[data-act=close]')?.addEventListener('click', () => this.close());
    host.querySelector('[data-act=regen]')?.addEventListener('click', () => {
      this.value = this.generate();
      this.render();
    });
    host.querySelector('[data-act=fill]')?.addEventListener('click', () => void this.fill());

    document.body.appendChild(host);
    this.host = host;
    this.render();
    this.reposition();
    window.addEventListener('scroll', this.reposition, true);
    window.addEventListener('resize', this.reposition);
  }

  private generate(): string {
    return generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: this.length });
  }

  private render() {
    if (!this.host) return;
    const out = this.host.querySelector<HTMLDivElement>('[data-out]');
    const len = this.host.querySelector<HTMLSpanElement>('[data-len]');
    if (out) out.textContent = this.value;
    if (len) len.textContent = String(this.length);
  }

  private reposition = () => {
    if (!this.host || !this.field || !document.contains(this.field)) {
      this.close();
      return;
    }
    const rect = this.field.getBoundingClientRect();
    const width = this.host.offsetWidth || 300;
    const left = Math.min(rect.left, window.innerWidth - width - 12);
    const belowSpace = window.innerHeight - rect.bottom;
    const top =
      belowSpace > (this.host.offsetHeight || 220) + 8
        ? rect.bottom + 6
        : Math.max(8, rect.top - (this.host.offsetHeight || 220) - 6);
    this.host.style.left = `${Math.max(12, left)}px`;
    this.host.style.top = `${top}px`;
  };

  private async fill() {
    const field = this.field;
    if (!field) return;
    const password = this.value;
    await copyText(password);

    // Fill the invoking field plus any sibling password fields that aren't the
    // "current/old" password (so signup password + confirm both get the value).
    const form = field.form;
    const targets = form
      ? Array.from(form.querySelectorAll<HTMLInputElement>('input[type=password]')).filter(
          (p) => !p.disabled && !p.readOnly && roleOfPasswordField(p) !== 'current',
        )
      : [field];
    if (!targets.includes(field)) targets.push(field);
    for (const t of targets) setNativeValue(t, password);

    field.focus();
    this.close();
  }

  close() {
    window.removeEventListener('scroll', this.reposition, true);
    window.removeEventListener('resize', this.reposition);
    this.host?.remove();
    this.host = null;
    this.field = null;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type PasswordRole = 'current' | 'new' | 'confirm' | 'unknown';

class CredentialCapture {
  // Only password fields the user actually typed into qualify. Browser autofill
  // and our own setNativeValue dispatch non-trusted input events, so we can
  // safely use isTrusted to ignore them.
  private userTypedPasswords = new WeakSet<HTMLInputElement>();
  // Dedupe by capture context + short time window. Avoids storing passwords:
  // submit + click can both fire for the same submission within milliseconds.
  private lastCaptureCtx = new WeakMap<HTMLFormElement | Document, number>();
  private static readonly DEDUP_WINDOW_MS = 2000;
  private prompt = new SavePrompt();

  init() {
    document.addEventListener('input', this.onInput, true);
    document.addEventListener('submit', this.onSubmit, true);
    document.addEventListener('click', this.onClick, true);
  }

  private onInput = (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.type !== 'password') return;
    if (!(e as InputEvent).isTrusted) return;
    if (!t.value) return;
    this.userTypedPasswords.add(t);
  };

  private onSubmit = (e: SubmitEvent) => {
    const form = e.target;
    if (form instanceof HTMLFormElement) this.captureFromContext(form);
  };

  private onClick = (e: MouseEvent) => {
    const target = e.target;
    if (!(target instanceof Element) || !target.isConnected) return;
    const button = target.closest<HTMLButtonElement | HTMLInputElement>(
      'button, [role=button], input[type=submit], input[type=button]',
    );
    if (!button) return;

    const form = button.closest('form');
    if (form && (button as HTMLButtonElement | HTMLInputElement).type === 'submit') {
      // The form submit listener will run; nothing to do here.
      return;
    }

    const ctx = form ?? document;
    const passwords = collectPasswordFields(ctx);
    if (passwords.length === 0) return;
    if (!passwords.some((p) => this.userTypedPasswords.has(p))) return;
    this.captureFromContext(ctx);
  };

  private captureFromContext(ctx: HTMLFormElement | Document) {
    const passwords = collectPasswordFields(ctx);
    if (passwords.length === 0) return;
    if (!passwords.some((p) => this.userTypedPasswords.has(p))) return;

    const roles = passwords.map(roleOfPasswordField);
    const newIdx = roles.findIndex((r) => r === 'new');
    const currentIdx = roles.findIndex((r) => r === 'current');

    let kind: CredentialSnapshot['kind'] = 'submit';
    let password = '';
    let oldPassword: string | undefined;

    if (newIdx !== -1 && currentIdx !== -1) {
      kind = 'change-form';
      password = passwords[newIdx]!.value;
      oldPassword = passwords[currentIdx]!.value || undefined;
    } else if (passwords.length >= 3 && newIdx !== -1) {
      kind = 'change-form';
      password = passwords[newIdx]!.value;
      const previous = passwords.find((p, i) => i !== newIdx && roles[i] !== 'confirm');
      oldPassword = previous?.value || undefined;
    } else if (passwords.length === 2 && newIdx === -1 && currentIdx === -1) {
      const [first, second] = passwords as [HTMLInputElement, HTMLInputElement];
      if (first.value && first.value === second.value) {
        password = first.value;
      } else if (first.value && second.value) {
        kind = 'change-form';
        oldPassword = first.value;
        password = second.value;
      }
    } else {
      const target =
        passwords.find((p) => this.userTypedPasswords.has(p) && p.value) ??
        passwords.find((p) => p.value);
      password = target?.value ?? '';
    }

    if (!password) return;

    const anchor = newIdx !== -1 ? passwords[newIdx]! : passwords[0]!;
    const username = pickUsernameField(ctx, anchor)?.value.trim() ?? '';

    const snapshot: CredentialSnapshot = {
      url: location.href,
      username,
      password,
      kind,
      ...(oldPassword ? { oldPassword } : {}),
    };

    const now = Date.now();
    const lastTime = this.lastCaptureCtx.get(ctx);
    if (lastTime != null && now - lastTime < CredentialCapture.DEDUP_WINDOW_MS) return;
    this.lastCaptureCtx.set(ctx, now);
    void this.sendCapture(snapshot);
  }

  private async sendCapture(snapshot: CredentialSnapshot) {
    try {
      const suggestion = await callBackground({ type: 'vault.capture', snapshot });
      if (suggestion) this.prompt.show(suggestion);
    } catch {
      // background unavailable or vault locked — nothing to prompt.
    }
  }
}

// In-page save/update prompt. Rendered as a floating card (bottom-right) so the
// user can store credentials without opening the popup or seeing an OS-level
// notification. Inline styles only, to avoid inheriting host-page CSS.
class SavePrompt {
  private host: HTMLDivElement | null = null;

  show(suggestion: PendingSuggestion) {
    this.close();
    const isSave = suggestion.action === 'save';
    const account = suggestion.username || '(no username)';
    const title = isSave ? 'Save to Monica KeePass?' : 'Update saved password?';
    const detail = isSave
      ? `${escapeHtml(account)} · ${escapeHtml(suggestion.origin)}`
      : `${escapeHtml(suggestion.entryTitle || account)} · ${escapeHtml(suggestion.origin)}`;

    const host = document.createElement('div');
    host.setAttribute('data-monica-save-prompt', '');
    Object.assign(host.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      width: '320px',
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      background: '#ffffff',
      color: '#1f2329',
      border: '1px solid #e3e6eb',
      borderRadius: '12px',
      boxShadow: '0 12px 32px rgba(16,24,40,0.22)',
      zIndex: '2147483647',
      padding: '14px',
      font: '14px system-ui, -apple-system, "Segoe UI", sans-serif',
    } satisfies Partial<CSSStyleDeclaration>);

    host.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="flex:0 0 auto;width:28px;height:28px;border-radius:8px;background:#eef2ff;display:flex;align-items:center;justify-content:center">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 19 6v5.7c0 5-3 7.9-7 9.3-4-1.4-7-4.3-7-9.3V6l7-3Z" fill="#4f46e5"/>
            <path d="M10.5 12.4 9 11l-1 1 2.5 2.6L16 9.6 15 8.6Z" fill="#fff"/>
          </svg>
        </div>
        <div style="flex:1 1 auto;min-width:0">
          <div style="font-weight:600;line-height:1.3">${escapeHtml(title)}</div>
          <div style="color:#6b7280;font-size:12px;margin-top:2px;word-break:break-all">${detail}</div>
        </div>
        <button data-act="close" aria-label="Close" style="flex:0 0 auto;border:none;background:none;cursor:pointer;color:#9aa3b2;padding:2px;line-height:0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6 6 18M6 6l12 12" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div data-err style="display:none;color:#dc2626;font-size:12px;margin-top:8px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button data-act="dismiss" style="cursor:pointer;border:1px solid #e3e6eb;background:#fff;color:#1f2329;border-radius:8px;padding:7px 12px;font:inherit;font-weight:550">Not now</button>
        <button data-act="apply" style="cursor:pointer;border:1px solid #4f46e5;background:#4f46e5;color:#fff;border-radius:8px;padding:7px 14px;font:inherit;font-weight:550">${isSave ? 'Save' : 'Update'}</button>
      </div>
    `;

    host.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-act=close]')?.addEventListener('click', () => this.close());
    host.querySelector('[data-act=dismiss]')?.addEventListener('click', () => {
      void callBackground({ type: 'vault.dismissPending' }).catch(() => {});
      this.close();
    });
    host.querySelector('[data-act=apply]')?.addEventListener('click', (e) => {
      void this.apply(e.currentTarget as HTMLButtonElement);
    });

    document.body.appendChild(host);
    this.host = host;
  }

  private async apply(button: HTMLButtonElement) {
    button.disabled = true;
    button.textContent = 'Saving…';
    button.style.opacity = '0.7';
    try {
      await callBackground({ type: 'vault.applyPending' });
      this.flashSaved();
    } catch (err) {
      button.disabled = false;
      button.style.opacity = '1';
      const errEl = this.host?.querySelector<HTMLDivElement>('[data-err]');
      if (errEl) {
        errEl.textContent = err instanceof Error ? err.message : 'Could not save';
        errEl.style.display = 'block';
      }
    }
  }

  private flashSaved() {
    if (!this.host) return;
    this.host.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.6"><path d="m5 12.5 4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span style="font-weight:600">Saved to Monica KeePass</span>
      </div>`;
    setTimeout(() => this.close(), 1400);
  }

  close() {
    this.host?.remove();
    this.host = null;
  }
}

function collectPasswordFields(ctx: HTMLFormElement | Document): HTMLInputElement[] {
  return Array.from(ctx.querySelectorAll<HTMLInputElement>('input[type=password]'))
    .filter((p) => !p.disabled && !p.readOnly && p.value.length > 0);
}

function roleOfPasswordField(input: HTMLInputElement): PasswordRole {
  const autocomplete = (input.autocomplete || '').toLowerCase();
  if (autocomplete.includes('current-password')) return 'current';
  if (autocomplete.includes('new-password')) return 'new';
  const hint = [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute('aria-label') ?? '',
  ]
    .join(' ')
    .toLowerCase();
  if (/(confirm|verify|repeat|again|retype)/.test(hint)) return 'confirm';
  if (/(old|current|original|existing|prev)/.test(hint)) return 'current';
  if (/new/.test(hint)) return 'new';
  return 'unknown';
}

function pickUsernameField(
  ctx: HTMLFormElement | Document,
  anchor: HTMLInputElement,
): HTMLInputElement | null {
  const candidates = Array.from(
    ctx.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR),
  ).filter((input) => !input.disabled && !input.readOnly && input.value.trim().length > 0);
  if (candidates.length === 0) return null;
  const before = candidates.filter(
    (c) => c.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return before.length > 0 ? before[before.length - 1]! : candidates[0]!;
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
