// Pure helpers for tags on buckets and objects (see "Tags" in docs/CONTRACT.md). The limits come
// from TAG_LIMITS in types.ts; the backend enforces the same ones. Shared by the editor and the mock.

import { TAG_LIMITS, type Tag } from "./types";

/** Length in Unicode characters (code points), as S3 counts them; not UTF-16 units. */
export const charCount = (s: string) => [...s].length;

const CHARS_HINT = "Use only letters, numbers, spaces and + - = . _ : / @";

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

/** Validate a complete tag set against `max` tags. Keys are compared exactly (case-sensitive). */
export function validateTags(tags: Tag[], max: number): TagValidation {
  const seen = new Map<string, number>();
  for (const t of tags) seen.set(t.key, (seen.get(t.key) ?? 0) + 1);
  const rows = tags.map((t) => ({
    key: tagKeyError(t.key) ?? ((seen.get(t.key) ?? 0) > 1 ? "This key is used more than once." : null),
    value: tagValueError(t.value),
  }));
  const set = tags.length > max ? `At most ${max} tags (this has ${tags.length}).` : null;
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
