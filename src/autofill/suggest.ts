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

export interface PendingSuggestionMetadata {
  action: PendingAction;
  url: string;
  origin: string;
  username: string;
  /** For 'update': the entry we will modify if the user accepts. */
  entryId?: string;
  entryTitle?: string;
  /** Other same-username candidates the popup can offer as alternatives. */
  alternateEntryIds?: string[];
  createdAt: number;
}

export interface PendingSuggestion extends PendingSuggestionMetadata {
  /** New password the user just submitted; never logged or persisted to disk. */
  newPassword: string;
}

export interface ComparedEntry {
  entry: EntrySummary;
  matchesNewPassword: boolean;
  matchesOldPassword: boolean;
}

/**
 * Decide whether pre-compared entries should produce a save/update prompt.
 * Stored password values stay outside this pure decision boundary.
 */
export function decideSuggestionFromComparisons(
  urlMatched: ComparedEntry[],
  snapshot: CredentialSnapshot,
): PendingSuggestion | null {
  if (!snapshot.password) return null;

  const usernameKey = normalizeUsername(snapshot.username);
  const sameUser = urlMatched.filter(
    ({ entry }) => normalizeUsername(entry.username) === usernameKey,
  );

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
  const alreadySaved = sameUser.some(({ matchesNewPassword }) => matchesNewPassword);
  if (alreadySaved) return null;

  // 3. Password-change form: prefer the entry whose stored password matches
  // the "current password" the user typed.
  let target: ComparedEntry | undefined;
  if (snapshot.kind === 'change-form' && snapshot.oldPassword) {
    target = sameUser.find(({ matchesOldPassword }) => matchesOldPassword);
  }

  // 4. Otherwise fall back to the best-ranked same-username match.
  if (!target) target = sameUser[0]!;
  const targetEntry = target.entry;

  return {
    action: 'update',
    url: snapshot.url,
    origin: displayOrigin(snapshot.url),
    username: snapshot.username,
    newPassword: snapshot.password,
    entryId: targetEntry.id,
    entryTitle: targetEntry.title,
    alternateEntryIds: sameUser
      .map(({ entry }) => entry)
      .filter((entry) => entry.id !== targetEntry.id)
      .map((entry) => entry.id),
    createdAt: Date.now(),
  };
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function toPendingSuggestionMetadata(
  suggestion: PendingSuggestionMetadata,
): PendingSuggestionMetadata {
  return {
    action: suggestion.action,
    url: suggestion.url,
    origin: suggestion.origin,
    username: suggestion.username,
    entryId: suggestion.entryId,
    entryTitle: suggestion.entryTitle,
    alternateEntryIds: suggestion.alternateEntryIds,
    createdAt: suggestion.createdAt,
  };
}

function displayOrigin(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
