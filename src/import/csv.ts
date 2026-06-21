import type { NewEntryInput } from '@/src/vault/types';

// Parse and map password CSVs exported by Chromium browsers (Chrome / Edge /
// Brave) and, best-effort, Firefox. Pure functions — no DOM, no chrome.* — so
// they can be unit-tested in the harness.
//
// Chrome/Edge header: name,url,username,password[,note]
// Firefox header:     "url","username","password",... (no name column)

/** RFC 4180 parser: handles quoted fields, "" escapes, and CRLF/LF/CR. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  // Strip a leading UTF-8 BOM if present.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      if (s[i + 1] === '\n') i++;
      pushRow();
    } else {
      field += c;
    }
  }
  // Flush trailing field/row unless the input ended exactly on a newline.
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export interface CsvMapResult {
  entries: NewEntryInput[];
  /** Data rows skipped because they had no usable username/password/url. */
  skippedEmpty: number;
}

const HEADER_ALIASES: Record<keyof Pick<NewEntryInput, 'title' | 'username' | 'password' | 'url' | 'notes'>, string[]> = {
  title: ['name', 'title'],
  url: ['url', 'login_uri', 'website', 'web site', 'uri'],
  username: ['username', 'login_username', 'user', 'email', 'login_name'],
  password: ['password', 'login_password', 'pass'],
  notes: ['note', 'notes', 'comments'],
};

function findIndex(header: string[], aliases: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const i = norm.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

function hostFromUrl(url: string): string {
  const v = url.trim();
  if (!v) return '';
  try {
    return new URL(v.includes('://') ? v : `https://${v}`).hostname.replace(/^www\./, '');
  } catch {
    return v;
  }
}

/**
 * Map parsed CSV rows (first row = header) to vault entries. Throws if the
 * header has no recognizable password/username columns.
 */
export function rowsToEntries(rows: string[][]): CsvMapResult {
  if (rows.length < 2) {
    throw new Error('CSV has no data rows');
  }
  const header = rows[0]!;
  const idx = {
    title: findIndex(header, HEADER_ALIASES.title),
    url: findIndex(header, HEADER_ALIASES.url),
    username: findIndex(header, HEADER_ALIASES.username),
    password: findIndex(header, HEADER_ALIASES.password),
    notes: findIndex(header, HEADER_ALIASES.notes),
  };

  if (idx.password === -1 && idx.username === -1) {
    throw new Error('Unrecognized CSV: no username or password column found');
  }

  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');

  const entries: NewEntryInput[] = [];
  let skippedEmpty = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const url = cell(row, idx.url);
    const username = cell(row, idx.username);
    const password = cell(row, idx.password);
    const notes = cell(row, idx.notes);
    let title = cell(row, idx.title);

    if (!username && !password && !url) {
      skippedEmpty++;
      continue;
    }
    if (!title) title = hostFromUrl(url) || username || '(untitled)';

    entries.push({ title, username, password, url, notes });
  }

  return { entries, skippedEmpty };
}

/** Convenience: parse CSV text straight to entries. */
export function csvToEntries(text: string): CsvMapResult {
  return rowsToEntries(parseCsv(text));
}
