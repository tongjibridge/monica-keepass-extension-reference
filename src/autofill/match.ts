import { getDomain } from 'tldts';
import type { EntrySummary } from '@/src/vault/types';

// Bitwarden-style URL matcher, ported from the Android autofill matcher:
// exact host > parent/child subdomain relation > same base domain.
// KeePass imports often store the URL-looking value in Title instead of URL, so
// titles that parse as a host/URL are also treated as URI signals.

interface ScoredMatch {
  entry: EntrySummary;
  score: number;
}

const MAX_SUGGESTIONS = 20;

export function matchEntriesForUrl(entries: EntrySummary[], pageUrl: string): EntrySummary[] {
  const targetHost = normalizeHost(pageUrl);
  if (!targetHost) return [];

  const targetRoot = extractBaseDomain(targetHost);
  const candidates = entries
    .map((entry) => scoreEntry(entry, targetHost, targetRoot))
    .filter((match): match is ScoredMatch => match != null);

  return candidates
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, MAX_SUGGESTIONS)
    .map((match) => match.entry);
}

function scoreEntry(
  entry: EntrySummary,
  targetHost: string,
  targetRoot: string,
): ScoredMatch | null {
  let bestScore = 0;

  for (const entryHost of extractEntryHosts(entry)) {
    const entryRoot = extractBaseDomain(entryHost);
    const hasSubdomainRelation = isSubdomainRelation(entryHost, targetHost);
    let score = 0;

    if (entryHost === targetHost) {
      score = 140;
    } else if (hasSubdomainRelation) {
      score = 115;
    } else if (entryRoot && targetRoot && entryRoot === targetRoot) {
      score = 100;
    }

    if (score > bestScore) bestScore = score;
  }

  return bestScore > 0 ? { entry, score: bestScore } : null;
}

function extractEntryHosts(entry: EntrySummary): string[] {
  const values = [entry.url, entry.title].filter(looksLikeUrlSignal);
  const hosts = values
    .flatMap((value) => value.split(/[\s,;|]+/))
    .map(normalizeHost)
    .filter((host): host is string => host != null);
  return Array.from(new Set(hosts));
}

function looksLikeUrlSignal(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ||
    /^www\./i.test(v) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#]|$)/i.test(v);
}

function normalizeHost(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw || raw.startsWith('androidapp://') || raw.startsWith('android-app://')) return null;

  const fullValue = raw.includes('://') ? raw : `https://${raw}`;
  let parsedHost: string | null = null;
  try {
    parsedHost = new URL(fullValue).hostname;
  } catch {
    parsedHost = null;
  }

  const fallbackHost = raw.split('/')[0]?.split(':')[0] ?? '';
  const host = (parsedHost || fallbackHost)
    .replace(/^www\./, '')
    .replace(/\.+$/, '')
    .trim();

  return host || null;
}

function extractBaseDomain(host: string): string {
  return getDomain(host) ?? host;
}

function isSubdomainRelation(left: string, right: string): boolean {
  if (left === right) return false;
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}
