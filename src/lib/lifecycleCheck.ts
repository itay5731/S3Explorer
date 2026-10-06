// `validate_lifecycle` for the browser mock: a port of `validate_lifecycle` in
// src-tauri/src/lifecycle.rs (same rules, same `field` paths, similar messages). Only mock.ts
// imports this; the editor always asks the backend (api.validateLifecycle) and shows what it says,
// so the UI never carries its own copy of these rules.
//
// Field paths: "id", "filter.prefix", "filter.tags", "filter.tags[j].key",
// "filter.objectSizeGreaterThan", "filter.objectSizeLessThan", "transitions[j].storageClass|days|date",
// "expiration.days|date|expiredObjectDeleteMarker", "noncurrentVersionTransitions[j].storageClass|
// noncurrentDays|newerNoncurrentVersions", "noncurrentVersionExpiration.noncurrentDays|
// newerNoncurrentVersions", "abortIncompleteMultipartUpload.daysAfterInitiation"; `null` for a
// rule-level issue (no action, duplicate id) and, with `ruleIndex: null`, for the rule count.

import {
  LIFECYCLE_LIMITS,
  STORAGE_CLASS_RANK,
  TAG_LIMITS,
  type LifecycleConfiguration,
  type LifecycleFilter,
  type LifecycleIssue,
  type LifecycleRule,
  type TransitionStorageClass,
} from "./types";
import { tagKeyError, tagValueError } from "./tags";

const DAY_MS = 86_400_000;
const PREFIX_MAX_BYTES = 1024;
const INT_MAX = 2_147_483_647;

type When = { kind: "days"; n: number } | { kind: "date"; ms: number };

const daysText = (n: number) => (n === 1 ? "1 day" : `${n} days`);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const whenText = (w: When) => (w.kind === "days" ? `after ${daysText(w.n)}` : `on ${ymd(w.ms)}`);
const plusDays = (w: When, n: number) =>
  w.kind === "days" ? `after at least ${daysText(w.n + n)}` : `on ${ymd(w.ms + n * DAY_MS)} or later`;
const gapTo = (a: When, b: When): number | null =>
  a.kind === "days" && b.kind === "days" ? b.n - a.n : a.kind === "date" && b.kind === "date" ? Math.floor((b.ms - a.ms) / DAY_MS) : null;
const rank = (c: TransitionStorageClass) => STORAGE_CLASS_RANK[c] ?? 0;
/** STANDARD_IA and ONEZONE_IA: at least 30 days after creation, and an archive transition after one of
 * them at least 30 days later. INTELLIGENT_TIERING has neither constraint. */
const needs30Days = (c: TransitionStorageClass) => c === "STANDARD_IA" || c === "ONEZONE_IA";
const isArchive = (c: TransitionStorageClass) => c === "GLACIER_IR" || c === "GLACIER" || c === "DEEP_ARCHIVE";
const WATERFALL = "STANDARD_IA → INTELLIGENT_TIERING → ONEZONE_IA → GLACIER_IR → GLACIER → DEEP_ARCHIVE";
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Midnight UTC, as "YYYY-MM-DD" or RFC 3339; returns ms since the epoch or an error text. */
export function parseMidnight(s: string): number | string {
  const t = s.trim();
  const bad = `“${s}” is not a date. Use YYYY-MM-DD (midnight UTC).`;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (d) {
    const ms = Date.UTC(+d[1], +d[2] - 1, +d[3]);
    return ymd(ms) === t ? ms : bad;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(t);
  if (!m) return bad;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return bad;
  if (ms % DAY_MS !== 0) return `The date “${s}” is not at midnight UTC; S3 only accepts dates at 00:00:00 UTC.`;
  return ms;
}

class Checker {
  private rule: number;
  private out: LifecycleIssue[];
  constructor(rule: number, out: LifecycleIssue[]) {
    this.rule = rule;
    this.out = out;
  }
  add(field: string | null, message: string) {
    this.out.push({ ruleIndex: this.rule, field, message });
  }
  /** A whole number in min..=max, or an issue at `field`. */
  whole(n: unknown, min: number, max: number, field: string, what: string): number | null {
    if (typeof n === "number" && Number.isInteger(n) && n >= min && n <= max) return n;
    if (typeof n === "number" && Number.isInteger(n) && n > max) {
      this.add(field, `${what} must be at most ${max} (it is ${n}).`);
      return null;
    }
    this.add(field, `${what} must be a whole number, ${min} or more (it is ${String(n)}).`);
    return null;
  }
  when(
    days: number | null | undefined,
    date: string | null | undefined,
    minDays: number,
    base: string,
    what: string,
    needs: string,
    /** For a past date: "moves to GLACIER" / "is deleted". */
    pastVerb: string,
  ): When | null {
    const hasDays = days !== null && days !== undefined;
    const hasDate = date !== null && date !== undefined;
    if (!hasDays && !hasDate) {
      this.add(`${base}.days`, `Choose when ${needs}: a number of days or a date.`);
      return null;
    }
    if (hasDays && hasDate) {
      this.add(`${base}.days`, `${what} has both days and a date; use only one.`);
      return null;
    }
    if (hasDays) {
      const n = this.whole(days, minDays, INT_MAX, `${base}.days`, "Days");
      return n === null ? null : { kind: "days", n };
    }
    const r = parseMidnight(date as string);
    if (typeof r === "string") {
      this.add(`${base}.date`, r);
      return null;
    }
    // Valid for S3, but not a no-op: a warning-style issue ("Note: …") that doesn't block saving.
    if (r <= Math.floor(Date.now() / DAY_MS) * DAY_MS) {
      this.add(
        `${base}.date`,
        `Note: ${ymd(r)} is today or in the past, so every matching object, and every new one, ${pastVerb} at the next daily run.`,
      );
    }
    return { kind: "date", ms: r };
  }
}

function checkOrder(
  ck: Checker,
  items: [TransitionStorageClass, When | null][],
  base: string,
  noun: string,
  gap: boolean,
  daysField: string | null,
) {
  for (let j = 0; j < items.length; j++) {
    const [cj, wj] = items[j];
    const same = items.slice(0, j).findIndex(([c]) => c === cj);
    if (same >= 0) {
      ck.add(
        `${base}[${j}].storageClass`,
        `There is already a ${noun} to ${cj} in this rule (${noun} ${same + 1}). Each storage class can be used once.`,
      );
      continue;
    }
    if (!wj) continue;
    const whenField = `${base}[${j}].${daysField ?? wj.kind}`;
    // Compare with every class earlier in the waterfall (either list order); reported on the later class.
    for (let k = 0; k < items.length; k++) {
      const [ckClass, wk] = items[k];
      if (rank(ckClass) >= rank(cj) || !wk) continue;
      const g = gapTo(wk, wj);
      if (g === null) continue;
      if (g <= 0) {
        ck.add(
          whenField,
          `${capitalize(noun)} to ${cj} ${whenText(wj)} comes before (or at the same time as) the ${noun} to ${ckClass} ${whenText(wk)}: transitions follow S3's order ${WATERFALL}, so ${cj} must come later.`,
        );
        break;
      }
      if (gap && needs30Days(ckClass) && isArchive(cj) && g < LIFECYCLE_LIMITS.minDaysBetweenTiers) {
        ck.add(
          whenField,
          `${capitalize(noun)} to ${cj} ${whenText(wj)} comes before the ${LIFECYCLE_LIMITS.minDaysBetweenTiers}-day minimum for the earlier ${ckClass} ${noun} (${whenText(wk)}): it must be ${plusDays(wk, LIFECYCLE_LIMITS.minDaysBetweenTiers)}.`,
        );
        break;
      }
    }
  }
}

function checkFilter(ck: Checker, f: LifecycleFilter) {
  if (f.prefix !== null && f.prefix !== undefined) {
    const bytes = new TextEncoder().encode(f.prefix).length;
    if (bytes > PREFIX_MAX_BYTES)
      ck.add("filter.prefix", `The prefix is ${bytes} bytes long; the limit is ${PREFIX_MAX_BYTES} bytes (UTF-8).`);
  }
  const tags = f.tags ?? [];
  if (tags.length > TAG_LIMITS.objectMaxTags) {
    ck.add(
      "filter.tags",
      `A filter can have at most ${TAG_LIMITS.objectMaxTags} tags (an object never has more, so the rule could never match); there are ${tags.length}.`,
    );
  }
  tags.forEach((t, j) => {
    const field = `filter.tags[${j}].key`;
    const err = tagKeyError(t.key) ?? tagValueError(t.value);
    if (err) ck.add(field, tagKeyError(t.key) ? `Key: ${err}` : `Value: ${err}`);
    else if (tags.slice(0, j).some((o) => o.key === t.key)) ck.add(field, `The tag key “${t.key}” is used more than once in this filter.`);
  });
  const gt =
    f.objectSizeGreaterThan === null || f.objectSizeGreaterThan === undefined
      ? null
      : ck.whole(f.objectSizeGreaterThan, 0, Number.MAX_SAFE_INTEGER, "filter.objectSizeGreaterThan", "The minimum object size (bytes)");
  const lt =
    f.objectSizeLessThan === null || f.objectSizeLessThan === undefined
      ? null
      : ck.whole(f.objectSizeLessThan, 1, Number.MAX_SAFE_INTEGER, "filter.objectSizeLessThan", "The maximum object size (bytes)");
  if (gt !== null && lt !== null && gt >= lt) {
    ck.add(
      "filter.objectSizeGreaterThan",
      `“Larger than” (${gt} bytes) must be less than “smaller than” (${lt} bytes), or no object can match.`,
    );
  }
}

const hasTagsOrSize = (f: LifecycleFilter) =>
  (f.tags ?? []).length > 0 ||
  (f.objectSizeGreaterThan !== null && f.objectSizeGreaterThan !== undefined) ||
  (f.objectSizeLessThan !== null && f.objectSizeLessThan !== undefined);

function checkRule(ck: Checker, r: LifecycleRule) {
  const n = [...(r.id ?? "")].length;
  if (n === 0) ck.add("id", "Give the rule an ID (a name of up to 255 characters).");
  else if (n > LIFECYCLE_LIMITS.ruleIdMaxChars)
    ck.add("id", `The rule ID is ${n} characters long; the limit is ${LIFECYCLE_LIMITS.ruleIdMaxChars}.`);

  const transitions = r.transitions ?? [];
  const nct = r.noncurrentVersionTransitions ?? [];
  if (!transitions.length && !r.expiration && !nct.length && !r.noncurrentVersionExpiration && !r.abortIncompleteMultipartUpload) {
    ck.add(
      null,
      "This rule does nothing: add at least one action (a transition, an expiration, a noncurrent-version action, or aborting incomplete multipart uploads).",
    );
  }

  const filter = r.filter ?? {
    prefix: null,
    tags: [],
    objectSizeGreaterThan: null,
    objectSizeLessThan: null,
  };
  checkFilter(ck, filter);
  const tagOrSize = hasTagsOrSize(filter);

  const current: [TransitionStorageClass, When | null][] = [];
  transitions.forEach((t, j) => {
    const base = `transitions[${j}]`;
    // Day 0 is allowed for transitions (moves on the day of creation).
    const w = ck.when(t.days, t.date, 0, base, `The transition to ${t.storageClass}`, `objects move to ${t.storageClass}`, `moves to ${t.storageClass}`);
    if (w && w.kind === "days" && needs30Days(t.storageClass) && w.n < LIFECYCLE_LIMITS.minDaysToInfrequentAccess) {
      ck.add(
        `${base}.days`,
        `A transition to ${t.storageClass} must be at least ${LIFECYCLE_LIMITS.minDaysToInfrequentAccess} days after creation (this one is after ${daysText(w.n)}).`,
      );
    }
    current.push([t.storageClass, w]);
  });
  checkOrder(ck, current, "transitions", "transition", true, null);

  let expWhen: When | null = null;
  const e = r.expiration;
  if (e) {
    if (e.expiredObjectDeleteMarker) {
      if ((e.days !== null && e.days !== undefined) || (e.date !== null && e.date !== undefined)) {
        ck.add(
          "expiration.expiredObjectDeleteMarker",
          "“Delete expired object delete markers” can't be combined with days or a date in the same expiration.",
        );
      }
      if (tagOrSize) {
        ck.add(
          "expiration.expiredObjectDeleteMarker",
          "“Delete expired object delete markers” can't be used in a rule whose filter has tags or object-size conditions.",
        );
      }
    } else {
      expWhen = ck.when(e.days, e.date, 1, "expiration", "The expiration", "objects expire", "is deleted");
    }
    if (expWhen) {
      for (const [cls, wt] of current) {
        if (!wt) continue;
        const g = gapTo(wt, expWhen);
        if (g !== null && g <= 0) {
          ck.add(
            `expiration.${expWhen.kind}`,
            `Expiration ${whenText(expWhen)} must come after every transition; the transition to ${cls} is ${whenText(wt)}.`,
          );
          break;
        }
      }
    }
  }

  const whens: [string, When][] = [];
  current.forEach(([, w], j) => w && whens.push([`transitions[${j}].${w.kind}`, w]));
  if (expWhen) whens.push([`expiration.${expWhen.kind}`, expWhen]);
  if (whens.some(([, w]) => w.kind === "days")) {
    const date = whens.find(([, w]) => w.kind === "date");
    if (date) ck.add(date[0], "Use days for every transition and the expiration in this rule, or dates for all of them, not a mix.");
  }

  const noncurrent: [TransitionStorageClass, When | null][] = [];
  nct.forEach((t, j) => {
    const base = `noncurrentVersionTransitions[${j}]`;
    let w: When | null = null;
    if (t.noncurrentDays === null || t.noncurrentDays === undefined) {
      ck.add(`${base}.noncurrentDays`, `Enter how many days after becoming noncurrent versions move to ${t.storageClass}.`);
    } else {
      const d = ck.whole(t.noncurrentDays, 1, INT_MAX, `${base}.noncurrentDays`, "Noncurrent days");
      if (d !== null) w = { kind: "days", n: d };
    }
    if (t.newerNoncurrentVersions !== null && t.newerNoncurrentVersions !== undefined) {
      const { min, max } = LIFECYCLE_LIMITS.newerNoncurrentVersions;
      ck.whole(t.newerNoncurrentVersions, min, max, `${base}.newerNoncurrentVersions`, "Versions to keep");
    }
    noncurrent.push([t.storageClass, w]);
  });
  checkOrder(ck, noncurrent, "noncurrentVersionTransitions", "noncurrent-version transition", false, "noncurrentDays");

  const ne = r.noncurrentVersionExpiration;
  if (ne) {
    let days: number | null = null;
    if (ne.noncurrentDays === null || ne.noncurrentDays === undefined) {
      ck.add("noncurrentVersionExpiration.noncurrentDays", "Enter how many days after becoming noncurrent versions are deleted.");
    } else {
      days = ck.whole(ne.noncurrentDays, 1, INT_MAX, "noncurrentVersionExpiration.noncurrentDays", "Noncurrent days");
    }
    if (ne.newerNoncurrentVersions !== null && ne.newerNoncurrentVersions !== undefined) {
      const { min, max } = LIFECYCLE_LIMITS.newerNoncurrentVersions;
      ck.whole(ne.newerNoncurrentVersions, min, max, "noncurrentVersionExpiration.newerNoncurrentVersions", "Versions to keep");
    }
    if (days !== null) {
      const hit = noncurrent.find(([, w]) => w && w.kind === "days" && w.n >= (days as number));
      if (hit && hit[1] && hit[1].kind === "days") {
        ck.add(
          "noncurrentVersionExpiration.noncurrentDays",
          `Noncurrent versions are deleted after ${daysText(days)} but the noncurrent-version transition to ${hit[0]} is after ${daysText(hit[1].n)}; deletion must come after every transition.`,
        );
      }
    }
  }

  const a = r.abortIncompleteMultipartUpload;
  if (a) {
    const field = "abortIncompleteMultipartUpload.daysAfterInitiation";
    if (a.daysAfterInitiation === null || a.daysAfterInitiation === undefined) {
      ck.add(field, "Enter after how many days incomplete multipart uploads are aborted.");
    } else {
      ck.whole(a.daysAfterInitiation, 1, INT_MAX, field, "Days after the upload started");
    }
    if (tagOrSize) {
      ck.add(field, "Aborting incomplete multipart uploads can't be used in a rule whose filter has tags or object-size conditions.");
    }
  }
}

/** Every problem with `config`, placed by rule index and field (`[]`: valid). */
export function validateLifecycleConfig(config: LifecycleConfiguration): LifecycleIssue[] {
  const out: LifecycleIssue[] = [];
  const rules = config?.rules ?? [];
  if (rules.length > LIFECYCLE_LIMITS.maxRules) {
    out.push({
      ruleIndex: null,
      field: null,
      message: `A lifecycle configuration can have at most 1,000 rules; this one has ${rules.length.toLocaleString("en-US")}.`,
    });
  }
  const seen = new Map<string, number>();
  rules.forEach((r, i) => {
    checkRule(new Checker(i, out), r);
    if (!r.id) return;
    const first = seen.get(r.id);
    if (first !== undefined) {
      out.push({
        ruleIndex: i,
        field: null,
        message: `The rule ID “${r.id}” is already used by rule ${first + 1}. Rule IDs must be unique.`,
      });
    } else {
      seen.set(r.id, i);
    }
  });
  return out;
}
