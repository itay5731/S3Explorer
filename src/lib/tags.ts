// Pure helpers for tags on buckets and objects (see "Tags" in docs/CONTRACT.md). The limits come
// from TAG_LIMITS in types.ts; the backend enforces the same ones. Shared by the editor and the mock.

import { TAG_LIMITS, type Tag } from "./types";

/** Length in Unicode characters (code points), as S3 counts them; not UTF-16 units. */
export const charCount = (s: string) => [...s].length;

const CHARS_HINT = "Use only letters, numbers, spaces and + - = . _ : / @";

/**
 * An AWS system tag ("aws:cloudformation:stack-name", set by CloudFormation and others). It can be
 * read but not written: the editor shows it locked and passes it through unchanged in every save.
 * Case-insensitive, like the reserved-key check.
 */
export const isSystemTag = (t: { key: string }): boolean => t.key.toLowerCase().startsWith(TAG_LIMITS.reservedKeyPrefix);

/** A tag set split into the system tags (read-only) and the ones the user can edit, order kept. */
export function splitSystemTags(tags: Tag[]): { system: Tag[]; user: Tag[] } {
  return { system: tags.filter(isSystemTag), user: tags.filter((t) => !isSystemTag(t)) };
}

export function tagKeyError(key: string): string | null {
  const n = charCount(key);
  if (n === 0) return "Enter a key.";
  if (n > TAG_LIMITS.keyMaxChars) return `At most ${TAG_LIMITS.keyMaxChars} characters (this has ${n}).`;
  if (key.toLowerCase().startsWith(TAG_LIMITS.reservedKeyPrefix)) return `Keys starting with “${TAG_LIMITS.reservedKeyPrefix}” are reserved by AWS.`;
  if (!TAG_LIMITS.allowedChars.test(key)) return `${CHARS_HINT}.`;
  return null;
}

export function tagValueError(value: string): string | null {
  const n = charCount(value);
  if (n > TAG_LIMITS.valueMaxChars) return `At most ${TAG_LIMITS.valueMaxChars} characters (this has ${n}).`;
  if (!TAG_LIMITS.allowedChars.test(value)) return `${CHARS_HINT}.`;
  return null;
}

export interface TagValidation {
  /** Per row: problems with the key and the value. */
  rows: { key: string | null; value: string | null }[];
  /** A problem with the set as a whole (too many tags). */
  set: string | null;
  valid: boolean;
}

/**
 * Validate the editable tags against `max` tags in total. `locked` (AWS system tags, passed through
 * unchanged) count toward the total but are never invalid themselves. Keys are compared exactly
 * (case-sensitive).
 */
export function validateTags(tags: Tag[], max: number, locked = 0): TagValidation {
  const seen = new Map<string, number>();
  for (const t of tags) seen.set(t.key, (seen.get(t.key) ?? 0) + 1);
  const rows = tags.map((t) => ({
    key: tagKeyError(t.key) ?? ((seen.get(t.key) ?? 0) > 1 ? "This key is used more than once." : null),
    value: tagValueError(t.value),
  }));
  const total = tags.length + locked;
  const set =
    total > max ? `At most ${max} tags (this has ${total}${locked ? `, ${locked} of them set by AWS` : ""}).` : null;
  return { rows, set, valid: !set && rows.every((r) => !r.key && !r.value) };
}

/** Same set of key/value pairs, in any order. */
export function sameTagSet(a: Tag[], b: Tag[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((t) => [t.key, t.value]));
  return b.every((t) => m.has(t.key) && m.get(t.key) === t.value);
}

/** Tags sorted by key, for stable display. */
export const sortTags = (tags: Tag[]) => [...tags].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
