import type { EntrySummary } from '@/src/vault/types';

// Save/update suggestion logic. Kept pure (no DOM, no chrome.*) so it can be
// unit-tested with synthetic entries in scripts/harness.ts.

export type CredentialKind = 'submit' | 'change-form';

export interface CredentialSnapshot {
  url: string;
  username: string;
  password: string;
  /**
   * On password-change forms the user also types the current password; we use
   * it to pick the right stored entry when several share the username.
   */
  oldPassword?: string;
  kind: CredentialKind;
}

export type PendingAction = 'save' | 'update';

export interface PendingSuggestion {
  action: PendingAction;
  url: string;
  origin: string;
  username: string;
  /** New password the user just submitted; never logged or persisted to disk. */
  newPassword: string;
  /** For 'update': the entry we will modify if the user accepts. */
  entryId?: string;
  entryTitle?: string;
  /** Other same-username candidates the popup can offer as alternatives. */
  alternateEntryIds?: string[];
  createdAt: number;
}

/**
 * URL-matched entries enriched with the cleartext password for entries whose
 * username equals the snapshot username. Background fills passwords only for
 * the entries it actually needs to compare, so most entries stay opaque.
 */
export interface EnrichedEntry extends EntrySummary {
  password?: string;
}

/**
 * Decide whether the snapshot should produce a save prompt, an update prompt,
 * or be silently ignored.
 *
 * Inputs:
 * - `urlMatched`: entries already ranked by `matchEntriesForUrl` for the page.
 * - `snapshot`: what the user just submitted.
 */
export function decideSuggestion(
  urlMatched: EnrichedEntry[],
  snapshot: CredentialSnapshot,
): PendingSuggestion | null {
  if (!snapshot.password) return null;

  const usernameKey = normalizeUsername(snapshot.username);
  const sameUser = urlMatched.filter((e) => normalizeUsername(e.username) === usernameKey);

  // 1. Nothing on this site uses this username -> propose save.
  if (sameUser.length === 0) {
    return {
      action: 'save',
      url: snapshot.url,
      origin: displayOrigin(snapshot.url),
      username: snapshot.username,
      newPassword: snapshot.password,
      createdAt: Date.now(),
    };
  }

  // 2. An existing entry already stores this exact password -> silent.
  const alreadySaved = sameUser.some(
    (e) => typeof e.password === 'string' && e.password === snapshot.password,
  );
  if (alreadySaved) return null;

  // 3. Password-change form: prefer the entry whose stored password matches
  // the "current password" the user typed.
  let target: EnrichedEntry | undefined;
  if (snapshot.kind === 'change-form' && snapshot.oldPassword) {
    target = sameUser.find(
      (e) => typeof e.password === 'string' && e.password === snapshot.oldPassword,
    );
  }

  // 4. Otherwise fall back to the best-ranked same-username match.
  if (!target) target = sameUser[0]!;

  return {
    action: 'update',
    url: snapshot.url,
    origin: displayOrigin(snapshot.url),
    username: snapshot.username,
    newPassword: snapshot.password,
    entryId: target.id,
    entryTitle: target.title,
    alternateEntryIds: sameUser.filter((e) => e.id !== target!.id).map((e) => e.id),
    createdAt: Date.now(),
  };
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function displayOrigin(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
