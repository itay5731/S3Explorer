// Pure helpers for the lifecycle editor (see "Lifecycle configuration" in docs/CONTRACT.md):
// plain-language summaries, which rules delete data, the difference between two configurations,
// comparison, and size/day formatting. The confirmation before saving is built from these, so
// they must be exact. Validation is NOT here: the UI shows what `validate_lifecycle` returns.

import type {
  Expiration,
  LifecycleConfiguration,
  LifecycleFilter,
  LifecycleRule,
  NoncurrentExpiration,
  NoncurrentTransition,
  Tag,
  Transition,
  TransitionStorageClass,
} from "./types";

// ---- storage classes ---------------------------------------------------------------------------

/**
 * Every transition target in S3's waterfall order (STORAGE_CLASS_RANK, strictly increasing): a later
 * transition in a rule must go to a class further down this list. Also the order of the editor's select.
 */
export const TRANSITION_CLASSES: readonly TransitionStorageClass[] = [
  "STANDARD_IA",
  "INTELLIGENT_TIERING",
  "ONEZONE_IA",
  "GLACIER_IR",
  "GLACIER",
  "DEEP_ARCHIVE",
];

/** The names AWS uses in its console. */
export const STORAGE_CLASS_NAMES: Record<TransitionStorageClass, string> = {
  STANDARD_IA: "Standard-IA",
  ONEZONE_IA: "One Zone-IA",
  INTELLIGENT_TIERING: "Intelligent-Tiering",
  GLACIER_IR: "Glacier Instant Retrieval",
  GLACIER: "Glacier Flexible Retrieval",
  DEEP_ARCHIVE: "Glacier Deep Archive",
};

export const storageClassName = (c: TransitionStorageClass): string => STORAGE_CLASS_NAMES[c] ?? c;

// ---- numbers, sizes, days, dates ------------------------------------------------------------------

export type SizeUnit = "B" | "KiB" | "MiB" | "GiB";
export const SIZE_UNITS: readonly { unit: SizeUnit; bytes: number }[] = [
  { unit: "B", bytes: 1 },
  { unit: "KiB", bytes: 1024 },
  { unit: "MiB", bytes: 1024 ** 2 },
  { unit: "GiB", bytes: 1024 ** 3 },
];

export const unitBytes = (unit: SizeUnit): number => SIZE_UNITS.find((u) => u.unit === unit)?.bytes ?? 1;

/** `value` in `unit` as bytes. Not rounded: a fraction of a byte stays visible to validation. */
export const toBytes = (value: number, unit: SizeUnit): number => value * unitBytes(unit);

/** The largest unit that represents `bytes` exactly (0 and non-integers stay in bytes). */
export function fromBytes(bytes: number): { value: number; unit: SizeUnit } {
  if (Number.isInteger(bytes) && bytes > 0) {
    for (let i = SIZE_UNITS.length - 1; i > 0; i--) {
      const u = SIZE_UNITS[i];
      if (bytes % u.bytes === 0) return { value: bytes / u.bytes, unit: u.unit };
    }
  }
  return { value: bytes, unit: "B" };
}

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });

/** "1 MiB", "1,500 bytes", "1 byte". Exact, never rounded. */
export function formatSize(bytes: number): string {
  const { value, unit } = fromBytes(bytes);
  if (unit === "B") return `${num(value)} ${value === 1 ? "byte" : "bytes"}`;
  return `${num(value)} ${unit}`;
}

/** "1 day", "30 days", "1,000 days". */
export const formatDays = (n: number): string => `${num(n)} ${n === 1 ? "day" : "days"}`;

/** "2027-01-01" for "2027-01-01" or "2027-01-01T00:00:00Z"; other text unchanged. */
export function formatDate(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?(?:Z|[+-]00:00))?$/.exec(s.trim());
  return m ? m[1] : s;
}

/** The value an `<input type="date">` shows for a stored date. */
export const dateInputValue = (s: string | null): string => (s ? (/^\d{4}-\d{2}-\d{2}/.exec(s)?.[0] ?? "") : "");

/**
 * A date from `<input type="date">` as sent to the backend: "YYYY-MM-DD", meaning midnight UTC. The
 * server returns "YYYY-MM-DDT00:00:00Z"; comparisons treat both spellings as the same date.
 */
export const dateFromInput = (v: string): string | null => (v ? v : null);

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// ---- summaries -------------------------------------------------------------------------------------

/** True when the filter has no condition: the rule applies to every object in the bucket. */
export const isEmptyFilter = (f: LifecycleFilter): boolean =>
  !f.prefix && f.tags.length === 0 && f.objectSizeGreaterThan === null && f.objectSizeLessThan === null;

const tagText = (t: Tag) => `${t.key}=${t.value}`;

/** "under logs/", "whose key starts with “img”". */
function prefixText(prefix: string): string {
  return prefix.endsWith("/") ? `under ${prefix}` : `whose key starts with “${prefix}”`;
}

/** The conditions as a phrase without the subject: "under logs/ tagged env=prod larger than 1 MiB". */
function filterConditions(f: LifecycleFilter): string[] {
  const parts: string[] = [];
  if (f.prefix) parts.push(prefixText(f.prefix));
  if (f.tags.length) parts.push(`tagged ${f.tags.map(tagText).join(" and ")}`);
  const gt = isNum(f.objectSizeGreaterThan) ? f.objectSizeGreaterThan : null;
  const lt = isNum(f.objectSizeLessThan) ? f.objectSizeLessThan : null;
  if (gt !== null && lt !== null) parts.push(`larger than ${formatSize(gt)} and smaller than ${formatSize(lt)}`);
  else if (gt !== null) parts.push(`larger than ${formatSize(gt)}`);
  else if (lt !== null) parts.push(`smaller than ${formatSize(lt)}`);
  return parts;
}

/** "All objects in the bucket", or "Objects under logs/ tagged env=prod larger than 1 MiB". */
export function describeFilter(f: LifecycleFilter): string {
  const parts = filterConditions(f);
  return parts.length ? `Objects ${parts.join(" ")}` : "All objects in the bucket";
}

/** Today's date in UTC as "YYYY-MM-DD" (lifecycle dates are midnight UTC). */
export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/**
 * A lifecycle date compared with `today` ("YYYY-MM-DD", UTC): "past" covers today too, because the
 * date's midnight UTC has already been reached. null when the text isn't a date.
 */
export function dateTense(date: string, today: string = todayUtc()): "past" | "future" | null {
  const d = canonDate(date);
  if (d === null || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d <= today ? "past" : "future";
}

/**
 * What a date-based action does, in words. A date that is today or past is not a no-op: S3 applies
 * it to every matching object, and to each new one, at the next daily run.
 */
function dateAction(date: string, verb: { now: string; from: string }, today: string): string | null {
  const t = dateTense(date, today);
  const d = formatDate(date);
  if (t === "past") return `every matching object, and each new one, ${verb.now} at the next daily run (date ${d} has passed)`;
  if (t === "future") return `from ${d}, every matching object of any age ${verb.from}`;
  return null;
}

/** A warning-style issue from `validate_lifecycle`: shown at its field, never blocks saving. */
export const isNoteIssue = (i: { message: string }): boolean => i.message.startsWith("Note: ");

/** "after 30 days" / "on 2027-01-01" / "(when not set)". */
function whenText(days: number | null, date: string | null): string {
  if (isNum(days) && date) return `after ${formatDays(days)} and on ${formatDate(date)}`;
  if (isNum(days)) return `after ${formatDays(days)}`;
  if (date) return `on ${formatDate(date)}`;
  return "(when is not set)";
}

const daysOrUnset = (n: number | null | undefined) => (isNum(n) ? `after ${formatDays(n)}` : "(days not set)");
const keeping = (n: number | null) => (isNum(n) ? `, keeping the ${num(n)} newest` : "");

function transitionsText(ts: Transition[], today: string): string | null {
  if (!ts.length) return null;
  // A date phrase is a clause of its own ("from <d>, every matching object …"): separate with "; ".
  let out = "";
  ts.forEach((t, i) => {
    const cls = storageClassName(t.storageClass);
    const byDate = !isNum(t.days) && t.date ? dateAction(t.date, { now: `moves to ${cls}`, from: `moves to ${cls}` }, today) : null;
    const part = byDate ?? `${i === 0 ? "move" : "then"} to ${cls} ${whenText(t.days, t.date)}`;
    const prevByDate = i > 0 && !isNum(ts[i - 1].days) && !!ts[i - 1].date && dateTense(ts[i - 1].date as string, today) !== null;
    out += i === 0 ? part : `${byDate || prevByDate ? "; " : ", "}${part}`;
  });
  return out;
}

function expirationText(e: Expiration | null, today: string): string | null {
  if (!e) return null;
  const parts: string[] = [];
  const byDate = !isNum(e.days) && e.date ? dateAction(e.date, { now: "is deleted", from: "is deleted" }, today) : null;
  if (byDate) parts.push(byDate);
  else if (isNum(e.days) || e.date) parts.push(`delete ${whenText(e.days, e.date)}`);
  if (e.expiredObjectDeleteMarker) parts.push("remove delete markers that have no older versions left");
  return parts.length ? parts.join(", and ") : "delete (when is not set)";
}

function noncurrentText(ts: NoncurrentTransition[], e: NoncurrentExpiration | null): string | null {
  const parts: string[] = [];
  ts.forEach((t, i) => {
    parts.push(
      `${i === 0 ? "move" : "then"} to ${storageClassName(t.storageClass)} ${daysOrUnset(t.noncurrentDays)}${keeping(t.newerNoncurrentVersions)}`,
    );
  });
  const moves = parts.length ? parts.join(", ") : null;
  const del = e ? `delete ${daysOrUnset(e.noncurrentDays)}${keeping(e.newerNoncurrentVersions)}` : null;
  if (!moves && !del) return null;
  return [moves, del].filter(Boolean).join("; ");
}

/**
 * One rule in plain language, e.g. "Objects under logs/ tagged env=prod larger than 1 MiB: move to
 * Glacier Instant Retrieval after 30 days, then to Glacier Deep Archive after 180 days; delete after
 * 365 days. Noncurrent versions: delete after 30 days, keeping the 2 newest. Incomplete multipart
 * uploads are aborted after 7 days." Never throws on an incomplete rule (unset values say so).
 * Dates: one that is today or past (UTC) means "every matching object, and each new one, … at the
 * next daily run"; a future one "from <date>, every matching object of any age …". `today` is
 * "YYYY-MM-DD" (UTC), for tests.
 */
export function describeRule(rule: LifecycleRule, today: string = todayUtc()): string {
  const subject = describeFilter(rule.filter);
  const current = [transitionsText(rule.transitions, today), expirationText(rule.expiration, today)].filter(Boolean).join("; ");
  const sentences: string[] = [];
  if (current) sentences.push(`${subject}: ${current}.`);
  else sentences.push(`Applies to ${subject.charAt(0).toLowerCase()}${subject.slice(1)}.`);
  const nc = noncurrentText(rule.noncurrentVersionTransitions, rule.noncurrentVersionExpiration);
  if (nc) sentences.push(`Noncurrent versions: ${nc}.`);
  const abort = rule.abortIncompleteMultipartUpload;
  if (abort) sentences.push(`Incomplete multipart uploads are aborted ${daysOrUnset(abort.daysAfterInitiation)}.`);
  if (
    !rule.transitions.length &&
    !rule.expiration &&
    !rule.noncurrentVersionTransitions.length &&
    !rule.noncurrentVersionExpiration &&
    !abort
  ) {
    sentences.push("No actions yet.");
  }
  return sentences.join(" ");
}

// ---- deleting data ------------------------------------------------------------------------------------

/** Any expiration (days, date or expired delete markers) or a noncurrent-version expiration. */
export const ruleDeletesData = (r: LifecycleRule): boolean => r.expiration !== null || r.noncurrentVersionExpiration !== null;

/** Every rule in `config` that deletes data, in order, with its index. Disabled rules are included. */
export function rulesDeletingData(config: LifecycleConfiguration | null): { index: number; rule: LifecycleRule }[] {
  return (config?.rules ?? []).flatMap((rule, index) => (ruleDeletesData(rule) ? [{ index, rule }] : []));
}

// ---- comparison --------------------------------------------------------------------------------------

/** A midnight-UTC date in one spelling ("2027-01-01T00:00:00Z" and "2027-01-01" are the same date). */
function canonDate(s: string | null): string | null {
  if (s === null) return null;
  const d = formatDate(s);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : s;
}

const cmp = (a: unknown, b: unknown) => {
  const x = JSON.stringify(a ?? null);
  const y = JSON.stringify(b ?? null);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * A rule in canonical form, mirroring the backend's `canonical_rule`: an empty prefix is no prefix,
 * filter tags sorted, dates in one spelling, transitions sorted (their order carries no meaning).
 * Keys are written in a fixed order, so the JSON text of two equal rules is equal.
 */
export function canonicalRule(r: LifecycleRule) {
  const tags = [...r.filter.tags].map((t) => ({ key: t.key, value: t.value })).sort(cmp);
  const transitions = r.transitions
    .map((t) => ({
      days: t.days ?? null,
      date: canonDate(t.date ?? null),
      storageClass: t.storageClass,
    }))
    .sort((a, b) => cmp([a.days, a.date, a.storageClass], [b.days, b.date, b.storageClass]));
  const nct = r.noncurrentVersionTransitions
    .map((t) => ({
      noncurrentDays: t.noncurrentDays ?? null,
      newerNoncurrentVersions: t.newerNoncurrentVersions ?? null,
      storageClass: t.storageClass,
    }))
    .sort((a, b) =>
      cmp([a.noncurrentDays, a.newerNoncurrentVersions, a.storageClass], [b.noncurrentDays, b.newerNoncurrentVersions, b.storageClass]),
    );
  return {
    id: r.id,
    status: r.status,
    filter: {
      prefix: r.filter.prefix ? r.filter.prefix : null,
      tags,
      objectSizeGreaterThan: r.filter.objectSizeGreaterThan ?? null,
      objectSizeLessThan: r.filter.objectSizeLessThan ?? null,
    },
    transitions,
    expiration: r.expiration
      ? {
          days: r.expiration.days ?? null,
          date: canonDate(r.expiration.date ?? null),
          expiredObjectDeleteMarker: !!r.expiration.expiredObjectDeleteMarker,
        }
      : null,
    noncurrentVersionTransitions: nct,
    noncurrentVersionExpiration: r.noncurrentVersionExpiration
      ? {
          noncurrentDays: r.noncurrentVersionExpiration.noncurrentDays ?? null,
          newerNoncurrentVersions: r.noncurrentVersionExpiration.newerNoncurrentVersions ?? null,
        }
      : null,
    abortIncompleteMultipartUpload: r.abortIncompleteMultipartUpload
      ? {
          daysAfterInitiation: r.abortIncompleteMultipartUpload.daysAfterInitiation ?? null,
        }
      : null,
  };
}

/**
 * The canonical JSON text of a rule, cached per rule object. Callers never mutate a rule in place
 * (the editor replaces it), so the cache stays right; it keeps comparing 1,000 rules on every
 * keystroke cheap.
 */
const canonicalKeys = new WeakMap<LifecycleRule, string>();
export function canonicalKey(r: LifecycleRule): string {
  let k = canonicalKeys.get(r);
  if (k === undefined) {
    k = JSON.stringify(canonicalRule(r));
    canonicalKeys.set(r, k);
  }
  return k;
}

export const sameRule = (a: LifecycleRule, b: LifecycleRule): boolean => a === b || canonicalKey(a) === canonicalKey(b);

/**
 * Same rules in the same order (rule order matters to S3), compared by meaning: key order in the
 * objects, filter-tag order, transition order and date spelling don't matter. No configuration and
 * an empty one are the same (saving no rules deletes the configuration). Mirrors the backend's
 * `same_configuration`, which decides `Conflict`.
 */
export function sameConfiguration(a: LifecycleConfiguration | null, b: LifecycleConfiguration | null): boolean {
  const ra = a?.rules ?? [];
  const rb = b?.rules ?? [];
  return ra.length === rb.length && ra.every((r, i) => sameRule(r, rb[i]));
}

export interface ConfigurationDiff {
  /** Rules whose id is new, in their new order. */
  added: { index: number; rule: LifecycleRule }[];
  /** Rules whose id is gone, in their old order. */
  removed: { index: number; rule: LifecycleRule }[];
  /** Same id, different content. */
  changed: { index: number; before: LifecycleRule; after: LifecycleRule }[];
  /** The rules kept on both sides are in a different order. */
  reordered: boolean;
  /** `after` has no rules: saving deletes the bucket's lifecycle configuration. */
  removesConfiguration: boolean;
  /** Nothing differs (see `sameConfiguration`). */
  same: boolean;
}

/**
 * What saving `after` over `before` changes, matching rules by id (renaming a rule therefore shows
 * as one removed and one added). With duplicate ids (never valid) each id matches once, in order.
 */
export function diffConfigurations(before: LifecycleConfiguration | null, after: LifecycleConfiguration | null): ConfigurationDiff {
  const b = before?.rules ?? [];
  const a = after?.rules ?? [];
  const pool = new Map<string, number[]>();
  b.forEach((r, i) => pool.set(r.id, [...(pool.get(r.id) ?? []), i]));
  const matched = new Set<number>();
  const added: ConfigurationDiff["added"] = [];
  const changed: ConfigurationDiff["changed"] = [];
  const keptOrder: number[] = [];
  a.forEach((rule, index) => {
    const i = pool.get(rule.id)?.shift();
    if (i === undefined) {
      added.push({ index, rule });
      return;
    }
    matched.add(i);
    keptOrder.push(i);
    if (!sameRule(b[i], rule)) changed.push({ index, before: b[i], after: rule });
  });
  const removed = b.flatMap((rule, index) => (matched.has(index) ? [] : [{ index, rule }]));
  const reordered = keptOrder.some((v, i) => i > 0 && v < keptOrder[i - 1]);
  return {
    added,
    removed,
    changed,
    reordered,
    removesConfiguration: a.length === 0 && b.length > 0,
    same: sameConfiguration(before, after),
  };
}

/**
 * Rule ids whose rule on the server changed between `base` (what the draft was made from) and
 * `current` (the server's configuration read again after a `Conflict`): added, removed or edited by
 * someone else. A draft that differs from `current` on one of these ids reverts that change.
 * With duplicate ids (never valid) the first rule of each id counts.
 */
export function serverChangedIds(base: LifecycleConfiguration | null, current: LifecycleConfiguration | null): Set<string> {
  const first = (c: LifecycleConfiguration | null) => {
    const m = new Map<string, LifecycleRule>();
    for (const r of c?.rules ?? []) if (!m.has(r.id)) m.set(r.id, r);
    return m;
  };
  const b = first(base);
  const c = first(current);
  const out = new Set<string>();
  for (const id of new Set([...b.keys(), ...c.keys()])) {
    const x = b.get(id);
    const y = c.get(id);
    if (!x || !y || !sameRule(x, y)) out.add(id);
  }
  return out;
}

// ---- new rules ----------------------------------------------------------------------------------------

export const emptyFilter = (): LifecycleFilter => ({
  prefix: null,
  tags: [],
  objectSizeGreaterThan: null,
  objectSizeLessThan: null,
});

/** An id not in `taken`: "rule-1", "rule-2", … (or `base-2`, … when a base is given). */
export function uniqueRuleId(taken: Iterable<string>, base = "rule"): string {
  const set = new Set(taken);
  if (base !== "rule" && !set.has(base)) return base;
  for (let n = base === "rule" ? 1 : 2; ; n++) {
    const id = `${base}-${n}`;
    if (!set.has(id)) return id;
  }
}

/** A new enabled rule with an empty filter and no actions (it is invalid until an action is added). */
export function emptyRule(takenIds: Iterable<string> = []): LifecycleRule {
  return {
    id: uniqueRuleId(takenIds),
    status: "Enabled",
    filter: emptyFilter(),
    transitions: [],
    expiration: null,
    noncurrentVersionTransitions: [],
    noncurrentVersionExpiration: null,
    abortIncompleteMultipartUpload: null,
  };
}

/** A deep copy (rules are plain JSON). */
export const cloneRule = (r: LifecycleRule): LifecycleRule => JSON.parse(JSON.stringify(r)) as LifecycleRule;

/** A copy of `r` with a fresh id ("logs-copy", "logs-copy-2", …). */
export function duplicateRule(r: LifecycleRule, takenIds: Iterable<string>): LifecycleRule {
  return {
    ...cloneRule(r),
    id: uniqueRuleId(takenIds, `${r.id || "rule"}-copy`),
  };
}

/** The configuration as the "As JSON" view shows it (our model, two-space indent). */
export function configurationJson(c: LifecycleConfiguration | null): string {
  // Keys in the model's order (as types.ts declares them) so every rule reads the same way; the
  // values are shown exactly as they are, nothing is normalized.
  const rules = (c?.rules ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    filter: {
      prefix: r.filter.prefix,
      tags: r.filter.tags.map((t) => ({ key: t.key, value: t.value })),
      objectSizeGreaterThan: r.filter.objectSizeGreaterThan,
      objectSizeLessThan: r.filter.objectSizeLessThan,
    },
    transitions: r.transitions.map((t) => ({ days: t.days, date: t.date, storageClass: t.storageClass })),
    expiration: r.expiration && { days: r.expiration.days, date: r.expiration.date, expiredObjectDeleteMarker: r.expiration.expiredObjectDeleteMarker },
    noncurrentVersionTransitions: r.noncurrentVersionTransitions.map((t) => ({
      noncurrentDays: t.noncurrentDays,
      newerNoncurrentVersions: t.newerNoncurrentVersions,
      storageClass: t.storageClass,
    })),
    noncurrentVersionExpiration: r.noncurrentVersionExpiration && {
      noncurrentDays: r.noncurrentVersionExpiration.noncurrentDays,
      newerNoncurrentVersions: r.noncurrentVersionExpiration.newerNoncurrentVersions,
    },
    abortIncompleteMultipartUpload: r.abortIncompleteMultipartUpload && {
      daysAfterInitiation: r.abortIncompleteMultipartUpload.daysAfterInitiation,
    },
  }));
  return JSON.stringify({ rules }, null, 2);
}
