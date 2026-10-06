// In-memory fake backend used when the UI runs in a plain browser (`npm run dev`).
// Simulates a realistic account: a handful of buckets, nested folders, a folder with
// 5,000 objects, paged listing with continuation tokens and transfers with live progress.

import type { Backend, FileDropEvent, Unlisten } from "./api";
import type {
  AddedBucket,
  AppSettings,
  AppError,
  Bucket,
  BucketVersioning,
  ConnectionConfig,
  ConnectionInfo,
  ErrorCode,
  FolderEntry,
  Job,
  JobItem,
  JobPreview,
  JobRequest,
  LifecycleConfiguration,
  LifecycleRule,
  ListPage,
  ObjectEntry,
  ObjectMeta,
  ProfileInfo,
  RecentListing,
  SaveConnectionInput,
  SavedConnection,
  Tag,
  Transfer,
  UpdateInfo,
  UpdateProgress,
} from "./types";
import { DEFAULT_APP_SETTINGS, JOB_MAX_ITEMS, SAVED_CONNECTION_NAME_MAX, TAG_LIMITS } from "./types";
import { planParts, validateAppSettings } from "./settings";
import { parseBucketInput } from "./buckets";
import { isSystemTag, sameTagSet, validateTags } from "./tags";
import { validateLifecycleConfig } from "./lifecycleCheck";
import { sameConfiguration } from "./lifecycle";

// ---- deterministic randomness ----------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5eed);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (min: number, max: number) => Math.floor(min + rand() * (max - min));
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const DAY = 86_400_000;
const NOW = Date.now();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const latency = () => delay(90 + rand() * 220);
const fail = (code: ErrorCode, message: string): AppError => ({ code, message });

// ---- data model -------------------------------------------------------------

interface MockObject {
  size: number;
  lastModified: string;
  etag: string;
  storageClass: string;
  contentType: string;
  metadata: Record<string, string>;
  versionId: string | null;
  tags?: Tag[];
}

interface MockBucket {
  creationDate: string;
  objects: Map<string, MockObject>;
  sorted: string[] | null; // cache, invalidated on mutation
  /** Not returned by list_buckets: reachable only when added by name (a bucket shared from another account). */
  hidden?: boolean;
  /** Writes (uploads, new folders, copies into it, deletes, tag edits) are denied, like a read-only share. */
  readOnly?: boolean;
  /** Bucket tag set; undefined = no tag set. */
  tags?: Tag[];
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml",
  gif: "image/gif", ico: "image/x-icon", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg",
  pdf: "application/pdf", json: "application/json", html: "text/html", css: "text/css",
  js: "text/javascript", txt: "text/plain", md: "text/markdown", csv: "text/csv", gz: "application/gzip",
  zip: "application/zip", parquet: "application/vnd.apache.parquet", xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sql: "application/sql",
  tar: "application/x-tar", log: "text/plain", xml: "application/xml", woff2: "font/woff2",
};
function contentTypeFor(key: string): string {
  const i = key.lastIndexOf(".");
  return (i > 0 && CONTENT_TYPES[key.slice(i + 1).toLowerCase()]) || "application/octet-stream";
}

const buckets = new Map<string, MockBucket>();

function createMockBucket(name: string, created: string, opts: { hidden?: boolean; readOnly?: boolean } = {}): MockBucket {
  const b: MockBucket = { creationDate: created, objects: new Map(), sorted: null, ...opts };
  buckets.set(name, b);
  return b;
}

function put(
  b: MockBucket,
  key: string,
  size: number,
  opts: { ageDays?: number; storageClass?: string; metadata?: Record<string, string>; tags?: Tag[] } = {},
) {
  const age = opts.ageDays ?? rand() * 400;
  b.objects.set(key, {
    size,
    lastModified: new Date(NOW - age * DAY - rand() * DAY).toISOString(),
    etag: `${hex(32)}${size > 16 * MB ? "-" + Math.ceil(size / (8 * MB)) : ""}`,
    storageClass: opts.storageClass ?? "STANDARD",
    contentType: key.endsWith("/") ? "application/x-directory" : contentTypeFor(key),
    metadata: opts.metadata ?? {},
    versionId: rand() > 0.6 ? hex(32) : null,
    ...(opts.tags ? { tags: opts.tags } : {}),
  });
  b.sorted = null;
}

const tagList = (o: Record<string, string>): Tag[] => Object.entries(o).map(([key, value]) => ({ key, value }));

function seed() {
  // 1. acme-prod-assets: mixed media, unicode names, nested folders
  const assets = createMockBucket("acme-prod-assets", "2021-03-14T09:12:44Z");
  for (const f of ["index.html", "robots.txt", "favicon.ico", "manifest.json"]) put(assets, f, between(300, 40 * KB));
  const products = ["sneaker", "backpack", "jacket", "watch", "headphones", "lamp", "mug", "notebook"];
  for (let i = 0; i < 140; i++) {
    put(assets, `images/products/${pick(products)}-${String(i + 1).padStart(4, "0")}.jpg`, between(80 * KB, 6 * MB), {
      metadata: { "uploaded-by": "cms-sync", sku: `SKU-${between(10000, 99999)}` },
    });
  }
  for (let i = 0; i < 24; i++) put(assets, `images/banners/hero-${i + 1}@2x.png`, between(400 * KB, 4 * MB));
  put(assets, "images/logo.svg", 4210, { ageDays: 700 });
  const videos = ["product-launch-2026.mp4", "brand film (director's cut).mp4", "tutorial 01 - getting started.mp4", "tutorial 02 - advanced.mp4", "teaser.mov"];
  for (const v of videos) put(assets, `videos/${v}`, between(60 * MB, 1.8 * GB), { storageClass: pick(["STANDARD", "STANDARD_IA"]) });
  put(assets, "docs/quarterly report Q3 2026.pdf", 3_481_222, { ageDays: 4 });
  put(assets, "docs/brand guidelines v4.pdf", 18_222_901, { ageDays: 120 });
  put(assets, "docs/pricing.xlsx", 88_120, { ageDays: 1 });
  put(assets, "docs/", 0, { ageDays: 500 });
  put(assets, "docs/Été 2025/plage à Nice.jpg", 5_120_331, { ageDays: 90 });
  put(assets, "docs/Été 2025/carnet de voyage.md", 12_004, { ageDays: 88 });
  put(assets, "日本語フォルダ/ファイル一覧.txt", 2_048, { ageDays: 33 });
  put(assets, "日本語フォルダ/写真 001.jpg", 2_400_000, { ageDays: 33 });
  put(assets, "empty folder/", 0, { ageDays: 10 });
  // Unusual but legal prefixes: a double slash (empty segment) and leading/trailing spaces + unicode.
  put(assets, "reports/annual 2025.pdf", 1_402_118, { ageDays: 60 });
  put(assets, "reports//2026/q1 summary.csv", 44_012, { ageDays: 20 });
  put(assets, "reports//2026/q2 summary.csv", 51_877, { ageDays: 12 });
  put(assets, " Ünïcødé  spaces 📁 /notes – été.txt", 3_210, { ageDays: 5 });
  put(assets, " Ünïcødé  spaces 📁 /photo 01.jpg", 1_800_000, { ageDays: 5 });
  // Per-object failures: keys containing "fail-copy" can't be copied; Glacier / Deep Archive need a restore.
  put(assets, "mixed/ok-1.txt", 1_024, { ageDays: 3 });
  put(assets, "mixed/ok-2.txt", 2_048, { ageDays: 3 });
  put(assets, "mixed/fail-copy-contract.pdf", 220_000, { ageDays: 3 });
  put(assets, "mixed/archive-2019.tar", 48 * MB, { ageDays: 900, storageClass: "GLACIER" });
  put(assets, "mixed/sub/deep.bin", 300 * MB, { ageDays: 1200, storageClass: "DEEP_ARCHIVE" });
  put(assets, "mixed/sub/fine.json", 812, { ageDays: 3 });
  put(assets, "docs/fail-copy-notes.txt", 9_400, { ageDays: 2 });
  // Conflict scenarios: two batches whose names collide with what's already published.
  put(assets, "published/report.csv", 1_000, { ageDays: 40 });
  put(assets, "published/photo.jpg", 2_000, { ageDays: 40 });
  put(assets, "staging/batch-1/report.csv", 1_111, { ageDays: 1 });
  put(assets, "staging/batch-1/photo.jpg", 2_222, { ageDays: 1 });
  put(assets, "staging/batch-1/new-1.txt", 111, { ageDays: 1 });
  put(assets, "staging/batch-2/report.csv", 3_333, { ageDays: 1 });
  put(assets, "staging/batch-2/photo.jpg", 4_444, { ageDays: 1 });
  put(assets, "staging/batch-2/new-2.txt", 222, { ageDays: 1 });

  // 2. acme-logs: the 5,000-object folder (virtualization stress test)
  const logs = createMockBucket("acme-logs", "2022-07-01T00:00:00Z");
  for (let i = 0; i < 5000; i++) {
    const day = String(1 + Math.floor(i / 200)).padStart(2, "0");
    const hour = String(Math.floor((i % 200) / 8.4)).padStart(2, "0");
    put(logs, `cloudfront/2026-10/E2QWRUHAPOMQZL.2026-10-${day}-${hour}.${hex(8)}.gz`, between(2 * KB, 900 * KB), {
      ageDays: 30 - i / 200,
      storageClass: i % 13 === 0 ? "STANDARD_IA" : "STANDARD",
    });
  }
  for (let i = 0; i < 640; i++) {
    put(logs, `cloudfront/2026-09/E2QWRUHAPOMQZL.2026-09-${String(1 + (i % 30)).padStart(2, "0")}.${hex(8)}.gz`, between(2 * KB, 700 * KB), {
      ageDays: 35 + rand() * 30,
      storageClass: "INTELLIGENT_TIERING",
    });
  }
  for (const svc of ["api-gateway", "auth-service", "billing", "worker"]) {
    for (let i = 0; i < 30; i++) put(logs, `app/${svc}/2026-10-${String(1 + (i % 5)).padStart(2, "0")}/part-${i}.log`, between(10 * KB, 50 * MB));
  }
  // More than JOB_MAX_ITEMS objects in one folder (selection guard).
  for (let i = 0; i < 10_050; i++) {
    put(logs, `firehose/2026/10/05/events-${String(i).padStart(5, "0")}.json.gz`, between(1 * KB, 64 * KB), { ageDays: 1 });
  }
  put(logs, "README.txt", 1_204, { ageDays: 800 });
  put(logs, "cloudfront/", 0, { ageDays: 900 });
  put(logs, "cloudfront/2026-10/", 0, { ageDays: 31 });

  // 3. data-lake-raw: partitioned parquet
  const lake = createMockBucket("data-lake-raw", "2023-02-10T15:30:00Z");
  for (const month of ["07", "08", "09", "10"]) {
    for (let i = 0; i < 48; i++) {
      put(lake, `events/year=2026/month=${month}/part-${String(i).padStart(5, "0")}-${hex(8)}.snappy.parquet`, between(20 * MB, 260 * MB), {
        storageClass: month === "07" ? "GLACIER_IR" : "STANDARD",
      });
    }
  }
  for (const s of ["events.json", "users.json", "orders.json"]) put(lake, `schemas/${s}`, between(2 * KB, 20 * KB));
  put(lake, "exports/customers 2026-09.csv", 412_888_123, { ageDays: 8 });

  // 4. website-static
  const web = createMockBucket("website-static", "2020-11-02T08:00:00Z");
  for (const f of ["index.html", "about.html", "pricing.html", "404.html", "sitemap.xml"]) put(web, f, between(2 * KB, 80 * KB));
  for (let i = 0; i < 18; i++) put(web, `assets/js/chunk-${hex(8)}.js`, between(10 * KB, 900 * KB));
  for (let i = 0; i < 6; i++) put(web, `assets/css/style-${hex(8)}.css`, between(5 * KB, 120 * KB));
  for (const f of ["inter-var.woff2", "jetbrains-mono.woff2"]) put(web, `assets/fonts/${f}`, between(80 * KB, 400 * KB));

  // 5. backups-archive: cold storage
  const backups = createMockBucket("backups-archive", "2019-05-20T22:10:00Z");
  for (let i = 0; i < 26; i++) {
    put(backups, `postgres/prod/pg_dump_2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + i).padStart(2, "0")}.sql.gz`, between(2 * GB, 14 * GB), {
      storageClass: i < 20 ? "DEEP_ARCHIVE" : "GLACIER",
      ageDays: 300 - i * 10,
    });
  }
  for (let i = 0; i < 12; i++) put(backups, `configs/etc-${2025 + Math.floor(i / 6)}-${i}.tar`, between(1 * MB, 30 * MB), { storageClass: "GLACIER_IR" });

  // ---- v0.4.0: tags, shared buckets, a server without tagging ----
  assets.tags = tagList({ team: "web", env: "prod", "cost-center": "4410" });
  logs.tags = tagList({ team: "platform", retention: "90d" });
  // Created by CloudFormation: AWS system tags (read-only, passed through on every save) next to a user tag.
  backups.tags = tagList({ "aws:cloudformation:stack-name": "backups-prod", "aws:cloudformation:logical-id": "ArchiveBucket", owner: "ops" });
  const tagged = (key: string, t: Record<string, string>) => {
    const o = assets.objects.get(key);
    if (o) o.tags = tagList(t);
  };
  tagged("docs/quarterly report Q3 2026.pdf", { project: "q3-report", owner: "finance", confidential: "yes" });
  tagged("docs/brand guidelines v4.pdf", { owner: "design" });
  tagged("images/logo.svg", { owner: "design", usage: "public" });
  // Nine tags: a bulk merge that adds two new keys pushes it over the limit of ten.
  tagged("mixed/ok-1.txt", { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7", h: "8", i: "9" });

  // Shared from other accounts: not in list_buckets, reachable once added by name.
  const shared = createMockBucket("partner-shared-data", "2024-04-02T10:00:00Z", { hidden: true });
  for (let i = 0; i < 14; i++) put(shared, `exchange/inbound/batch-${String(i + 1).padStart(3, "0")}.csv`, between(20 * KB, 4 * MB), { ageDays: i });
  for (let i = 0; i < 6; i++) put(shared, `exchange/outbound/report-${i + 1}.pdf`, between(100 * KB, 2 * MB), { ageDays: 2 + i });
  put(shared, "exchange/", 0, { ageDays: 300 });
  put(shared, "README.md", 2_380, { ageDays: 300, tags: tagList({ owner: "partner" }) });
  const feed = createMockBucket("vendor-readonly-feed", "2023-09-15T06:30:00Z", { hidden: true, readOnly: true });
  for (let i = 0; i < 20; i++) put(feed, `prices/2026-10-${String(1 + (i % 6)).padStart(2, "0")}/prices-${i}.json`, between(5 * KB, 300 * KB), { ageDays: 6 - (i % 6) });
  put(feed, "LICENSE.txt", 1_100, { ageDays: 700 });

  // A bucket on a server that doesn't implement tagging (MinIO-style): tags return NotSupported.
  const legacy = createMockBucket("legacy-minio-backups", "2018-02-01T12:00:00Z");
  for (let i = 0; i < 8; i++) put(legacy, `nightly/backup-${i + 1}.tar.gz`, between(10 * MB, 400 * MB), { ageDays: 8 - i });
}
seed();

/** Mock switch for tags: buckets whose name starts with "legacy-" behave like a server without tagging. */
const tagsUnsupported = (bucket: string) => bucket.startsWith("legacy-");

function sortedKeys(b: MockBucket): string[] {
  if (!b.sorted) b.sorted = [...b.objects.keys()].sort();
  return b.sorted;
}

/** First index in sorted `arr` whose value is >= `target`. */
function lowerBound(arr: string[], target: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---- connection ---------------------------------------------------------------

const profiles: ProfileInfo[] = [
  { name: "default", region: "us-east-1", hasCredentials: true },
  { name: "prod-admin", region: "eu-west-1", hasCredentials: true },
  { name: "restricted", region: "us-west-2", hasCredentials: true },
  { name: "minio-local", region: null, hasCredentials: true },
  { name: "sso-dev", region: "eu-central-1", hasCredentials: false },
];

let connection: ConnectionInfo | null = null;
/** The connection identity added buckets are stored under (see "Shared buckets" in docs/CONTRACT.md). */
let connectionKey: string | null = null;

const withScheme = (e: string | null | undefined) =>
  !e ? null : /^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `https://${e}`;

function requireConnection(): ConnectionInfo {
  if (!connection) throw fail("NotConnected", "Not connected. Choose a profile or enter credentials first.");
  return connection;
}

function requireBucket(name: string): MockBucket {
  requireConnection();
  const b = buckets.get(name);
  if (!b) throw fail("NoSuchBucket", `The bucket “${name}” does not exist.`);
  return b;
}

const DENIED_WRITE = "AccessDenied: Access Denied. These credentials can read this bucket but not change it (mock: read-only share).";

function requireWritable(name: string): MockBucket {
  const b = requireBucket(name);
  if (b.readOnly) throw fail("AccessDenied", DENIED_WRITE.slice("AccessDenied: ".length));
  return b;
}

// ---- shared buckets (added by name) ------------------------------------------------------
// The backend keeps added-buckets.json keyed by connection identity; the mock keeps the same map in
// localStorage. Mock switches for add_bucket: a name containing "missing" → NoSuchBucket, one
// containing "denied" → AccessDenied. Any other valid name that the mock doesn't know yet is
// created as a small hidden bucket, so every name can be tried.

const MOCK_ADDED_KEY = "s3x.mock.addedBuckets";

function loadAdded(): Record<string, AddedBucket[]> {
  try {
    const raw = localStorage.getItem(MOCK_ADDED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, AddedBucket[]>) : {};
  } catch {
    return {};
  }
}

function saveAdded(all: Record<string, AddedBucket[]>) {
  try {
    localStorage.setItem(MOCK_ADDED_KEY, JSON.stringify(all));
  } catch {
    /* in memory only */
  }
}

function addedForConnection(): AddedBucket[] {
  requireConnection();
  return [...(loadAdded()[connectionKey ?? ""] ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- tags --------------------------------------------------------------------------------

/** Every tag write the mock received, verbatim, for test inspection. */
const tagCallLog: { cmd: string; bucket: string; key: string | null; tags: Tag[]; expected: Tag[]; at: string }[] = [];

/**
 * Validate a tag write the way the backend does and return the set to store. AWS system tags
 * ("aws:…") are accepted only as a pass-through: the same key and value must be in `expected`; a new
 * or changed one is refused. System tags in `expected` are never dropped: they are kept even when
 * `tags` omits them, so the set is never deleted while one exists.
 */
function checkTagWrite(tags: Tag[], expected: Tag[], max: number): Tag[] {
  if (!Array.isArray(tags) || !Array.isArray(expected)) throw fail("InvalidInput", "tags and expected must be lists");
  const system = tags.filter(isSystemTag);
  for (const t of system) {
    if (!expected.some((e) => e.key === t.key && e.value === t.value)) {
      throw fail(
        "InvalidInput",
        `The tag key “${t.key}” starts with “aws:”, which is reserved for AWS: a system tag can only be kept unchanged, not added or changed.`,
      );
    }
  }
  const user = tags.filter((t) => !isSystemTag(t));
  const kept = expected.filter((e) => isSystemTag(e) && !system.some((t) => t.key === e.key));
  const v = validateTags(user, max, system.length + kept.length);
  if (!v.valid) {
    const i = v.rows.findIndex((r) => r.key || r.value);
    const msg = v.set ?? (i >= 0 ? `tags[${i}]: ${v.rows[i].key ?? v.rows[i].value}` : "invalid tags");
    throw fail("InvalidInput", msg);
  }
  return [...kept, ...tags];
}

/**
 * Test hook: make the next tag or lifecycle save fail. `write: true` stores the change first (the
 * failure happens after the write, like "Saved, but reading back failed…"); `false` stores nothing.
 */
type InjectedFailure = { code: ErrorCode; message: string; write: boolean };
const injected: { tags: InjectedFailure | null; lifecycle: InjectedFailure | null } = { tags: null, lifecycle: null };
function takeInjected(kind: "tags" | "lifecycle"): InjectedFailure | null {
  const f = injected[kind];
  injected[kind] = null;
  return f;
}

const notSupported = () => fail("NotSupported", "This server does not support tagging (NotImplemented).");
const conflict = () => fail("Conflict", "The tags were changed by someone else since they were loaded. Nothing was saved.");
const copyTags = (tags: Tag[] | undefined): Tag[] => (tags ?? []).map((t) => ({ ...t }));

// ---- lifecycle -----------------------------------------------------------------------------
// One configuration per bucket, kept in localStorage (mock-only key) so a reload keeps edits. A
// bucket missing from the stored map gets its seed (below); a bucket stored as null has none.
// Mock switches: "legacy-…" buckets → NotSupported (a server without lifecycle); buckets shared
// with you (added by name) → AccessDenied, like a real cross-account share.

const MOCK_LIFECYCLE_KEY = "s3x.mock.lifecycle";

const lcRule = ({ id, ...r }: Partial<LifecycleRule> & { id: string }): LifecycleRule => ({
  id,
  status: "Enabled",
  filter: { prefix: null, tags: [], objectSizeGreaterThan: null, objectSizeLessThan: null },
  transitions: [],
  expiration: null,
  noncurrentVersionTransitions: [],
  noncurrentVersionExpiration: null,
  abortIncompleteMultipartUpload: null,
  ...r,
});

const lcPrefix = (prefix: string) => ({ prefix, tags: [], objectSizeGreaterThan: null, objectSizeLessThan: null });

/** Realistic starting configurations. */
const LIFECYCLE_SEEDS: Record<string, LifecycleConfiguration> = {
  // A logs bucket: prefix rules with transitions and expirations.
  "acme-logs": {
    rules: [
      lcRule({
        id: "cloudfront-logs",
        filter: lcPrefix("cloudfront/"),
        transitions: [
          { days: 30, date: null, storageClass: "STANDARD_IA" },
          { days: 90, date: null, storageClass: "GLACIER_IR" },
        ],
        expiration: { days: 365, date: null, expiredObjectDeleteMarker: false },
      }),
      lcRule({
        id: "app-logs-90d",
        filter: lcPrefix("app/"),
        expiration: { days: 90, date: null, expiredObjectDeleteMarker: false },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
      }),
      lcRule({
        id: "firehose-cleanup",
        status: "Disabled",
        filter: lcPrefix("firehose/"),
        expiration: { days: 14, date: null, expiredObjectDeleteMarker: false },
      }),
      lcRule({ id: "abort-stale-uploads", abortIncompleteMultipartUpload: { daysAfterInitiation: 7 } }),
    ],
  },
  // Versioned: tag filters, an And filter (prefix + tag + size), noncurrent-version actions.
  "data-lake-raw": {
    rules: [
      lcRule({
        id: "archive-cold-partitions",
        filter: { prefix: "events/", tags: [{ key: "tier", value: "cold" }], objectSizeGreaterThan: 1_048_576, objectSizeLessThan: null },
        transitions: [
          { days: 30, date: null, storageClass: "GLACIER_IR" },
          { days: 180, date: null, storageClass: "DEEP_ARCHIVE" },
        ],
        noncurrentVersionExpiration: { noncurrentDays: 30, newerNoncurrentVersions: 2 },
      }),
      lcRule({
        id: "temporary-exports",
        filter: {
          prefix: null,
          tags: [
            { key: "temporary", value: "true" },
            { key: "team", value: "analytics" },
          ],
          objectSizeGreaterThan: null,
          objectSizeLessThan: null,
        },
        expiration: { days: 7, date: null, expiredObjectDeleteMarker: false },
      }),
      lcRule({
        id: "noncurrent-cleanup",
        expiration: { days: null, date: null, expiredObjectDeleteMarker: true },
        noncurrentVersionTransitions: [{ noncurrentDays: 30, newerNoncurrentVersions: null, storageClass: "GLACIER" }],
        noncurrentVersionExpiration: { noncurrentDays: 365, newerNoncurrentVersions: null },
      }),
    ],
  },
  // Read from a legacy rule with a top-level Prefix (no Filter): represented as filter.prefix.
  "backups-archive": {
    rules: [
      lcRule({
        id: "postgres-dumps",
        filter: lcPrefix("postgres/"),
        transitions: [
          { days: 1, date: null, storageClass: "GLACIER" },
          { days: 90, date: null, storageClass: "DEEP_ARCHIVE" },
        ],
        expiration: { days: 2555, date: null, expiredObjectDeleteMarker: false },
      }),
    ],
  },
};

/** Bucket versioning: one Enabled, one Suspended, the rest Off. */
const mockVersioning: Record<string, BucketVersioning> = { "data-lake-raw": "Enabled", "backups-archive": "Suspended" };

function cloneLc<T>(v: T): T {
  return v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function loadLifecycleStore(): Record<string, LifecycleConfiguration | null> {
  try {
    const raw = localStorage.getItem(MOCK_LIFECYCLE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, LifecycleConfiguration | null>;
  } catch {
    /* fall back to the seeds */
  }
  return {};
}

function storedLifecycle(bucket: string): LifecycleConfiguration | null {
  const all = loadLifecycleStore();
  const c = bucket in all ? all[bucket] : (LIFECYCLE_SEEDS[bucket] ?? null);
  return c && c.rules.length ? cloneLc(c) : null;
}

/** Like S3 reading it back: an empty prefix is no prefix, dates in the full midnight-UTC form. */
function asStored(c: LifecycleConfiguration): LifecycleConfiguration {
  const date = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? `${d.trim()}T00:00:00Z` : d);
  return {
    rules: c.rules.map((r) => ({
      ...cloneLc(r),
      filter: { ...cloneLc(r.filter), prefix: r.filter.prefix ? r.filter.prefix : null },
      transitions: r.transitions.map((t) => ({ ...t, date: date(t.date) })),
      expiration: r.expiration ? { ...r.expiration, date: date(r.expiration.date) } : null,
    })),
  };
}

function writeLifecycle(bucket: string, c: LifecycleConfiguration | null) {
  const all = loadLifecycleStore();
  all[bucket] = c && c.rules.length ? cloneLc(c) : null;
  try {
    localStorage.setItem(MOCK_LIFECYCLE_KEY, JSON.stringify(all));
  } catch {
    /* in memory only: the mock has no other place */
  }
}

const lifecycleUnsupported = (bucket: string) => bucket.startsWith("legacy-");
// More mock switches, for buckets added by name (they are not denied like other shared buckets):
// "notrans-…" refuses any rule with a transition (as SeaweedFS does: NotImplemented); "partial-…"
// accepts noncurrent-version actions but doesn't store them (the previous configuration is put
// back); "newclass-…" holds a configuration this version can't represent (a storage class it
// doesn't know), so it can't be shown or changed.
const lifecycleSwitch = (bucket: string) =>
  bucket.startsWith("notrans-") ? "notrans" : bucket.startsWith("partial-") ? "partial" : bucket.startsWith("newclass-") ? "newclass" : null;
const lifecycleDenied = (bucket: string, b: { hidden?: boolean; readOnly?: boolean }) => (!!b.hidden || !!b.readOnly) && !lifecycleSwitch(bucket);
const ruleLabel = (i: number, id: string) => (id ? `rule ${i + 1} (“${id}”)` : `rule ${i + 1}`);
const lifecycleNotSupported = () => fail("NotSupported", "This server does not support lifecycle configuration (NotImplemented).");

/** Every lifecycle write the mock received, verbatim (deep-cloned), for test inspection. */
const lifecycleCallLog: { cmd: string; bucket: string; config: unknown; expected: unknown; at: string }[] = [];

// ---- settings ------------------------------------------------------------------
// The real backend persists settings.json in the app config dir; the mock keeps them in
// localStorage (mock-only key) so a page reload behaves like an app restart.

const MOCK_SETTINGS_KEY = "s3x.mock.settings";

/** Like the backend: missing fields (e.g. a v0.2.0 three-field value) take their defaults. */
function loadMockSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(MOCK_SETTINGS_KEY);
    if (raw) {
      const merged = { ...DEFAULT_APP_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
      if (!validateAppSettings(merged)) return merged;
    }
  } catch {
    /* fall back to defaults */
  }
  return { ...DEFAULT_APP_SETTINGS };
}

let settings: AppSettings = loadMockSettings();

// ---- saved connections ---------------------------------------------------------------
// Metadata is kept in localStorage (mock-only key) like the backend's connections.json.
// Secrets stay in memory only, so after a reload a saved static connection has
// `hasSecret: false` (which exercises the "secret missing" path).
// Mock switches: a name containing "keychain-fail" makes saving fail with a Keychain error;
// one containing "keychain-locked" makes connecting fail with a Keychain error.

const MOCK_CONNECTIONS_KEY = "s3x.mock.connections";
type StoredConnection = Omit<SavedConnection, "hasSecret">;

function loadMockConnections(): StoredConnection[] {
  try {
    const raw = localStorage.getItem(MOCK_CONNECTIONS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as StoredConnection[]) : [];
  } catch {
    return [];
  }
}

let savedConnections: StoredConnection[] = loadMockConnections();
const mockKeychain = new Map<string, string>();

function persistConnections() {
  try {
    localStorage.setItem(MOCK_CONNECTIONS_KEY, JSON.stringify(savedConnections));
  } catch {
    /* in memory only */
  }
}

const withSecretFlag = (c: StoredConnection): SavedConnection => ({
  ...c,
  hasSecret: c.kind === "static" && mockKeychain.has(c.id),
});

function sortConnections(list: SavedConnection[]): SavedConnection[] {
  return list.sort((a, b) => {
    if (a.lastUsedAt !== b.lastUsedAt) {
      if (!a.lastUsedAt) return 1;
      if (!b.lastUsedAt) return -1;
      return b.lastUsedAt.localeCompare(a.lastUsedAt);
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// ---- updates ---------------------------------------------------------------------------
// localStorage "s3x.mock.update" picks the outcome of check_for_update:
// "none" (default, up to date) | "available" (installable) | "manual" (no signed package) | "error".

const MOCK_VERSION = "0.3.0";
const MOCK_UPDATE_KEY = "s3x.mock.update";
const RELEASES_URL = "https://github.com/yonatand/S3Explorer/releases/latest";
const MOCK_NOTES = [
  "## What's new in 0.3.1",
  "",
  "- **Faster listings** for folders with more than 10,000 objects",
  "- Saved connections now show when they were *last used*",
  "- Fixed: the `MiB/s` speed could flicker during uploads",
  "",
  "### Fixes",
  "",
  "1. Theme no longer flashes on startup",
  "2. Retry button on network errors, see [the issue](https://github.com/yonatand/S3Explorer/issues/42)",
  "",
  "<script>alert('raw html is never rendered')</script>",
  "Thanks to everyone who reported bugs.",
].join("\n");
let lastUpdate: UpdateInfo | null = null;
const updateListeners = new Set<(p: UpdateProgress) => void>();

function mockUpdateMode(): string {
  try {
    return localStorage.getItem(MOCK_UPDATE_KEY) ?? "none";
  } catch {
    return "none";
  }
}

// ---- transfers ------------------------------------------------------------------

interface Sim {
  t: Transfer;
  durationMs: number;
  startedMs: number;
  partSize: number;
  failAt: number | null; // fraction at which it fails
  failMessage: string;
}

const sims = new Map<string, Sim>();
const progressListeners = new Set<(t: Transfer) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
let idSeq = 0;

function emit(t: Transfer) {
  const copy = { ...t };
  for (const l of progressListeners) l(copy);
}

function ensureTicker() {
  if (!ticker) ticker = setInterval(tick, 100);
}

/** Start queued transfers (oldest first) while fewer than `maxConcurrentTransfers` run. */
function startQueued() {
  const now = Date.now();
  let running = 0;
  for (const s of sims.values()) if (s.t.status === "running") running++;
  for (const s of sims.values()) {
    if (running >= settings.maxConcurrentTransfers) break;
    if (s.t.status !== "queued") continue;
    // Part size is snapshotted when the transfer starts running.
    const plan = planParts(s.t.kind, settings.partSizeMib, s.t.totalBytes);
    s.partSize = plan.partBytes;
    s.t.partsTotal = plan.parts;
    s.t.status = "running";
    s.startedMs = now;
    running++;
    emit(s.t);
  }
}

function tick() {
  const now = Date.now();
  startQueued();
  let active = 0;
  for (const s of sims.values()) {
    if (s.t.status !== "running") {
      if (s.t.status === "queued") active++;
      continue;
    }
    active++;
    const frac = Math.min(1, (now - s.startedMs) / s.durationMs);
    // ease a little + jitter so speed looks alive
    const shaped = Math.min(1, frac * (0.92 + Math.random() * 0.16));
    const prev = s.t.transferredBytes;
    let next = Math.max(prev, Math.floor(s.t.totalBytes * shaped));
    if (s.t.kind === "upload") {
      // Uploads only report whole completed parts (small files jump 0 -> 100%).
      next = s.t.partsTotal <= 1 ? 0 : Math.max(prev, Math.floor(next / s.partSize) * s.partSize);
    }
    if (s.failAt !== null && frac >= s.failAt) {
      s.t.status = "failed";
      s.t.error = s.failMessage;
      s.t.bytesPerSec = 0;
      s.t.finishedAt = new Date().toISOString();
      emit(s.t);
      continue;
    }
    if (frac >= 1) {
      s.t.transferredBytes = s.t.totalBytes;
      s.t.partsDone = s.t.partsTotal;
      s.t.status = "completed";
      s.t.bytesPerSec = 0;
      s.t.finishedAt = new Date().toISOString();
      if (s.t.kind === "upload") {
        const b = buckets.get(s.t.bucket);
        if (b) put(b, s.t.key, s.t.totalBytes, { ageDays: 0, metadata: { "uploaded-with": "s3explorer" } });
      }
      emit(s.t);
      continue;
    }
    const elapsed = Math.max(0.1, (now - s.startedMs) / 1000);
    const instant = s.t.kind === "upload" ? next / elapsed : (next - prev) / 0.1 || 0;
    s.t.bytesPerSec = s.t.bytesPerSec ? s.t.bytesPerSec * 0.7 + instant * 0.3 : instant;
    s.t.transferredBytes = next;
    s.t.partsDone = Math.min(s.t.partsTotal, Math.floor(next / s.partSize));
    emit(s.t);
  }
  if (active === 0 && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function startSim(kind: Transfer["kind"], bucket: string, key: string, localPath: string, size: number, failMessage?: string): string {
  const id = `mock-${++idSeq}-${hex(6)}`;
  const { partBytes: partSize, parts } = planParts(kind, settings.partSizeMib, size);
  const t: Transfer = {
    id,
    kind,
    bucket,
    key,
    localPath,
    totalBytes: size,
    transferredBytes: 0,
    partsTotal: parts,
    partsDone: 0,
    bytesPerSec: 0,
    status: "queued",
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  sims.set(id, {
    t,
    durationMs: 3000 + Math.random() * 3000,
    startedMs: Date.now(),
    partSize,
    failAt: failMessage ? 0.05 : null,
    failMessage: failMessage ?? "",
  });
  emit(t);
  ensureTicker();
  return id;
}

// ---- fake local files for dialogs / drag & drop -----------------------------------

const FAKE_FILES = [
  "C:\\Users\\demo\\Desktop\\quarterly-results.xlsx",
  "C:\\Users\\demo\\Pictures\\Été à Nice.jpg",
  "C:\\Users\\demo\\Videos\\product launch 4k.mp4",
  "C:\\Users\\demo\\Documents\\meeting notes.md",
  "C:\\Users\\demo\\Downloads\\dataset-2026.parquet",
];
const fakeSize = (path: string) => {
  const h = hashString(path);
  return path.endsWith(".mp4") ? 300 * MB + (h % (900 * MB)) : 40 * KB + (h % (60 * MB));
};

// ---- jobs (delete / copy / move) -----------------------------------------------------
// Mirrors "Object operations (jobs)" in docs/CONTRACT.md: validation, prefix expansion,
// conflicts, skip vs overwrite, move = copy then delete each source as it goes, per-object
// failures, at most 2 running jobs (FIFO queue), cooperative cancel.
// Mock switches: keys containing "fail-copy" fail to copy; GLACIER / DEEP_ARCHIVE objects
// fail to copy until restored (like real S3).

const JOB_MAX_RUNNING = 2;
const JOB_PREVIEW_CAP = 100_000;
const JOB_ERRORS_MAX = 50;
const JOB_LIST_PER_TICK = 700; // keys "listed" per 100 ms while in the listing phase

interface JobWork {
  src: string;
  dest: string | null;
}

interface JobSim {
  job: Job;
  req: JobRequest;
  itemIdx: number;
  listing: { keys: string[]; pos: number; item: JobItem } | null;
  work: JobWork[];
  workPos: number;
  seenSrc: Set<string>;
}

const jobSims = new Map<string, JobSim>();
const jobListeners = new Set<(j: Job) => void>();
let jobTicker: ReturnType<typeof setInterval> | null = null;
let jobSeq = 0;

/** Test hook: the next preview_job takes this long (ms), to hold a preview open. */
const previewDelay: { next: number | null } = { next: null };
/** Every preview/start request the mock received, verbatim (deep-cloned), for test inspection. */
const jobCallLog: { cmd: "preview_job" | "start_job"; request: unknown; at: string }[] = [];
function logJobCall(cmd: "preview_job" | "start_job", request: JobRequest) {
  jobCallLog.push({ cmd, request: JSON.parse(JSON.stringify(request)), at: new Date().toISOString() });
}
// Test hook (mock only): inspect requests and the in-memory tree from a driver script.
(globalThis as Record<string, unknown>).__s3xMock = {
  jobCalls: jobCallLog,
  tagCalls: tagCallLog,
  objectTags: (bucket: string, key: string) => copyTags(buckets.get(bucket)?.objects.get(key)?.tags),
  bucketTags: (bucket: string) => copyTags(buckets.get(bucket)?.tags),
  /** Make the next tag / lifecycle save fail (see InjectedFailure). */
  failNextTagSave: (f: InjectedFailure) => {
    injected.tags = f;
  },
  failNextLifecycleSave: (f: InjectedFailure) => {
    injected.lifecycle = f;
  },
  /** Change tags behind the UI's back (simulates another client), to exercise Conflict. */
  setObjectTags: (bucket: string, key: string, tags: Tag[]) => {
    const o = buckets.get(bucket)?.objects.get(key);
    if (o) o.tags = tags.length ? copyTags(tags) : undefined;
  },
  setBucketTags: (bucket: string, tags: Tag[]) => {
    const b = buckets.get(bucket);
    if (b) b.tags = tags.length ? copyTags(tags) : undefined;
  },
  added: () => loadAdded(),
  lifecycleCalls: lifecycleCallLog,
  lifecycle: (bucket: string) => storedLifecycle(bucket),
  /** Replace a bucket's lifecycle configuration behind the UI's back (another client; no validation). */
  setLifecycle: (bucket: string, config: LifecycleConfiguration | null) => writeLifecycle(bucket, config),
  setVersioning: (bucket: string, v: BucketVersioning) => {
    mockVersioning[bucket] = v;
  },
  /** Add or remove an object behind the UI's back (another client); the UI sees it on its next listing. */
  putObject: (bucket: string, key: string, size = 1000) => {
    const b = buckets.get(bucket);
    if (b) put(b, key, size, { ageDays: 1 });
  },
  removeObject: (bucket: string, key: string) => {
    const b = buckets.get(bucket);
    if (b && b.objects.delete(key)) b.sorted = null;
  },
  slowNextPreview: (ms: number) => {
    previewDelay.next = ms;
  },
  has: (bucket: string, key: string) => !!buckets.get(bucket)?.objects.has(key),
  size: (bucket: string, key: string) => buckets.get(bucket)?.objects.get(key)?.size ?? null,
  keys: (bucket: string, prefix: string) => {
    const b = buckets.get(bucket);
    if (!b) return [];
    const keys = sortedKeys(b);
    const out: string[] = [];
    for (let i = lowerBound(keys, prefix); i < keys.length && keys[i].startsWith(prefix); i++) out.push(keys[i]);
    return out;
  },
};

const cloneJob = (j: Job): Job => ({ ...j, errors: j.errors.map((e) => ({ ...e })) });

function emitJob(j: Job) {
  const copy = cloneJob(j);
  for (const l of jobListeners) l(copy);
}

const invalid = (message: string) => fail("InvalidInput", message);

/** Contract validation. Throws InvalidInput (nothing is changed). */
function validateJobRequest(req: JobRequest) {
  requireConnection();
  if (!req || (req.kind !== "delete" && req.kind !== "copy" && req.kind !== "move" && req.kind !== "tag")) {
    throw invalid("kind must be one of delete, copy, move, tag");
  }
  if (req.kind === "tag") {
    const op = req.tags;
    if (!op) throw invalid("tags is required for kind tag");
    if (op.mode !== "merge" && op.mode !== "replace") throw invalid("tags.mode must be merge or replace");
    if (!Array.isArray(op.set) || !Array.isArray(op.remove)) throw invalid("tags.set and tags.remove must be lists");
    const v = validateTags(op.set, TAG_LIMITS.objectMaxTags);
    if (!v.valid) throw invalid(`tags.set: ${v.set ?? v.rows.map((r) => r.key ?? r.value).find(Boolean)}`);
    if (op.mode === "replace" && op.remove.length) throw invalid("tags.remove must be empty for replace");
    if (op.remove.some((k) => typeof k !== "string" || !k)) throw invalid("tags.remove: keys must not be empty");
  } else if (req.tags != null) {
    throw invalid(`tags is only allowed for kind tag`);
  }
  if (!Array.isArray(req.items) || req.items.length === 0) throw invalid("items must not be empty");
  if (req.items.length > JOB_MAX_ITEMS) {
    throw invalid(`items: at most ${JOB_MAX_ITEMS.toLocaleString("en-US")} per job (got ${req.items.length.toLocaleString("en-US")})`);
  }
  if (req.onConflict !== "overwrite" && req.onConflict !== "skip") throw invalid("onConflict must be overwrite or skip");
  requireBucket(req.srcBucket);
  const transfer = req.kind === "copy" || req.kind === "move";
  if (transfer) {
    if (!req.destBucket) throw invalid(`destBucket is required for ${req.kind}`);
    requireBucket(req.destBucket);
  } else if (req.destBucket != null) {
    throw invalid(`destBucket must be null for ${req.kind}`);
  }
  const sameBucket = transfer && req.destBucket === req.srcBucket;
  const dests: { to: string; isPrefix: boolean; i: number }[] = [];
  req.items.forEach((it, i) => {
    const at = `items[${i}]`;
    if (typeof it.from !== "string" || it.from === "") throw invalid(`${at}.from must not be empty`);
    if (it.isPrefix) {
      if (it.from === "/") throw invalid(`${at}.from: the prefix "/" is not allowed`);
      if (!it.from.endsWith("/")) throw invalid(`${at}.from must end with "/" when isPrefix is true`);
    }
    if (!transfer) {
      if (it.to != null) throw invalid(`${at}.to must be null for ${req.kind}`);
      return;
    }
    if (it.to == null) throw invalid(`${at}.to is required for ${req.kind}`);
    if (it.isPrefix) {
      if (it.to === "" || it.to === "/") throw invalid(`${at}.to: the prefix "${it.to}" is not allowed`);
      if (!it.to.endsWith("/")) throw invalid(`${at}.to must end with "/" when isPrefix is true`);
    } else {
      if (it.to === "") throw invalid(`${at}.to must not be empty`);
      if (it.to.endsWith("/")) throw invalid(`${at}.to: an object destination must not end with "/" (${it.to})`);
    }
    if (sameBucket && it.to === it.from) throw invalid(`${at}: the destination is the same as the source (${it.from})`);
    if (sameBucket && it.isPrefix && it.to.startsWith(it.from)) {
      throw invalid(`${at}: cannot ${req.kind} the folder ${it.from} into itself (${it.to})`);
    }
    dests.push({ to: it.to, isPrefix: it.isPrefix, i });
  });
  // Two items that would write the same destination key: identical destinations, or a
  // destination inside another item's destination prefix.
  dests.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const stack: { to: string; i: number }[] = [];
  for (let k = 0; k < dests.length; k++) {
    const d = dests[k];
    if (k > 0 && dests[k - 1].to === d.to) {
      throw invalid(`items[${dests[k - 1].i}] and items[${d.i}] would both write to ${d.to}`);
    }
    while (stack.length && !d.to.startsWith(stack[stack.length - 1].to)) stack.pop();
    if (stack.length) throw invalid(`items[${stack[stack.length - 1].i}] and items[${d.i}] would write into the same destination (${d.to})`);
    if (d.isPrefix) stack.push(d);
  }
}

function expandJobItem(b: MockBucket, it: JobItem): string[] {
  if (!it.isPrefix) return b.objects.has(it.from) ? [it.from] : [];
  const keys = sortedKeys(b);
  const out: string[] = [];
  for (let i = lowerBound(keys, it.from); i < keys.length && keys[i].startsWith(it.from); i++) out.push(keys[i]);
  return out;
}

const destKeyOf = (it: JobItem, key: string): string | null =>
  it.to == null ? null : it.isPrefix ? it.to + key.slice(it.from.length) : it.to;

function previewJobSync(req: JobRequest): JobPreview {
  validateJobRequest(req);
  const src = buckets.get(req.srcBucket)!;
  const dest = req.kind === "copy" || req.kind === "move" ? buckets.get(req.destBucket!)! : null;
  let objects = 0;
  let bytes = 0;
  let conflicts = 0;
  let truncated = false;
  const seenSrc = new Set<string>();
  const seenDest = new Set<string>();
  outer: for (const it of req.items) {
    for (const key of expandJobItem(src, it)) {
      if (seenSrc.has(key)) continue;
      if (objects >= JOB_PREVIEW_CAP) {
        truncated = true;
        break outer;
      }
      seenSrc.add(key);
      objects++;
      bytes += src.objects.get(key)!.size;
      if (dest) {
        const d = destKeyOf(it, key)!;
        if (seenDest.has(d)) throw invalid(`Two items would write the same destination key: ${d}`);
        seenDest.add(d);
        if (dest.objects.has(d)) conflicts++;
      }
    }
  }
  return { objects, bytes, conflicts, truncated };
}

const leafOf = (keyOrPrefix: string) => {
  const trimmed = keyOrPrefix.endsWith("/") ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  const i = trimmed.lastIndexOf("/");
  return trimmed.slice(i + 1) + (keyOrPrefix.endsWith("/") ? "/" : "");
};
const parentOf = (keyOrPrefix: string) => keyOrPrefix.slice(0, keyOrPrefix.length - leafOf(keyOrPrefix).length);

function jobLabel(req: JobRequest): string {
  const n = req.items.length;
  const first = req.items[0];
  const what = n === 1 ? leafOf(first.from) || first.from : `${n.toLocaleString("en-US")} items`;
  if (req.kind === "delete") return `Delete ${what}`;
  if (req.kind === "tag") return `${req.tags?.mode === "replace" ? "Replace tags of" : "Edit tags of"} ${what}`;
  if (n === 1 && req.kind === "move" && req.destBucket === req.srcBucket && first.to && parentOf(first.to) === parentOf(first.from)) {
    return `Rename ${what} to ${leafOf(first.to)}`;
  }
  const where = first.to ? parentOf(first.to) : "";
  return `${req.kind === "copy" ? "Copy" : "Move"} ${what} to ${req.destBucket}/${where}`;
}

function startJobSync(req: JobRequest): string {
  validateJobRequest(req);
  // The real backend also detects colliding expanded destinations; the mock checks up front.
  if (req.kind !== "delete") previewJobSync(req);
  const id = `job-${++jobSeq}-${hex(6)}`;
  const job: Job = {
    id,
    kind: req.kind,
    srcBucket: req.srcBucket,
    destBucket: req.kind === "copy" || req.kind === "move" ? req.destBucket : null,
    label: jobLabel(req),
    phase: "listing",
    totalItems: 0,
    doneItems: 0,
    skippedItems: 0,
    failedItems: 0,
    totalBytes: 0,
    doneBytes: 0,
    status: "queued",
    error: null,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const sim: JobSim = {
    job,
    req: JSON.parse(JSON.stringify(req)) as JobRequest,
    itemIdx: 0,
    listing: null,
    work: [],
    workPos: 0,
    seenSrc: new Set(),
  };
  jobSims.set(id, sim);
  emitJob(job);
  if (!jobTicker) jobTicker = setInterval(jobTick, 100);
  return id;
}

function jobError(sim: JobSim, key: string, message: string) {
  sim.job.failedItems++;
  if (sim.job.errors.length < JOB_ERRORS_MAX) sim.job.errors.push({ key, message });
}

function finishJob(sim: JobSim, status: "completed" | "failed" | "cancelled") {
  sim.job.status = status;
  sim.job.phase = "done";
  sim.job.finishedAt = new Date().toISOString();
  emitJob(sim.job);
}

const ARCHIVED: Record<string, string> = { GLACIER: "Glacier Flexible Retrieval", DEEP_ARCHIVE: "Glacier Deep Archive" };

/** List up to `budget` keys. Returns true when every item has been expanded. */
function listStep(sim: JobSim, budget: number): boolean {
  const src = buckets.get(sim.req.srcBucket);
  if (!src) {
    sim.job.error = `The bucket “${sim.req.srcBucket}” no longer exists.`;
    return true;
  }
  const add = (it: JobItem, key: string) => {
    if (sim.seenSrc.has(key)) return;
    sim.seenSrc.add(key);
    sim.work.push({ src: key, dest: destKeyOf(it, key) });
    sim.job.totalItems++;
    // A tag job moves no data: its byte counters stay 0.
    if (sim.req.kind !== "tag") sim.job.totalBytes += src.objects.get(key)?.size ?? 0;
  };
  while (budget > 0) {
    if (sim.listing) {
      const { keys, item } = sim.listing;
      while (budget > 0 && sim.listing.pos < keys.length) {
        add(item, keys[sim.listing.pos++]);
        budget--;
      }
      if (sim.listing.pos >= keys.length) sim.listing = null;
      continue;
    }
    if (sim.itemIdx >= sim.req.items.length) return true;
    const it = sim.req.items[sim.itemIdx++];
    if (!it.isPrefix) {
      if (src.objects.has(it.from)) add(it, it.from);
      else if (sim.req.kind === "delete") {
        // DeleteObjects on a missing key succeeds on S3 (nothing to delete).
        sim.job.totalItems++;
        sim.job.doneItems++;
      } else {
        sim.job.totalItems++;
        jobError(sim, it.from, "NoSuchKey: The specified key does not exist.");
      }
      budget--;
      continue;
    }
    const keys = expandJobItem(src, it);
    if (!keys.length) {
      sim.job.totalItems++;
      jobError(sim, it.from, "No objects found under this prefix.");
      budget--;
      continue;
    }
    sim.listing = { keys, pos: 0, item: it };
  }
  return false;
}

function workOne(sim: JobSim, w: JobWork) {
  const j = sim.job;
  const src = buckets.get(sim.req.srcBucket)!;
  const o = src.objects.get(w.src);
  if (!o) {
    if (sim.req.kind === "delete") j.doneItems++;
    else jobError(sim, w.src, "NoSuchKey: The source object no longer exists.");
    return;
  }
  if (sim.req.kind === "delete") {
    if (src.readOnly) {
      jobError(sim, w.src, DENIED_WRITE);
      return;
    }
    src.objects.delete(w.src);
    src.sorted = null;
    j.doneItems++;
    j.doneBytes += o.size;
    return;
  }
  if (sim.req.kind === "tag") {
    const op = sim.req.tags!;
    if (tagsUnsupported(sim.req.srcBucket)) {
      jobError(sim, w.src, "NotSupported: This server does not support object tagging.");
      return;
    }
    if (src.readOnly) {
      jobError(sim, w.src, "AccessDenied: Access Denied for s3:PutObjectTagging on this key.");
      return;
    }
    let next: Tag[];
    if (op.mode === "replace") next = copyTags(op.set);
    else {
      const m = new Map((o.tags ?? []).map((t) => [t.key, t.value]));
      for (const k of op.remove) m.delete(k);
      for (const t of op.set) m.set(t.key, t.value);
      next = [...m].map(([key, value]) => ({ key, value }));
    }
    if (next.length > TAG_LIMITS.objectMaxTags) {
      jobError(sim, w.src, `would have ${next.length} tags; the limit is ${TAG_LIMITS.objectMaxTags}`);
      return;
    }
    o.tags = next.length ? next : undefined;
    j.doneItems++;
    return;
  }
  if (w.src.includes("fail-copy")) {
    jobError(sim, w.src, "AccessDenied: Access Denied for s3:GetObject on this key (mock: keys containing “fail-copy” cannot be copied).");
    return;
  }
  if (ARCHIVED[o.storageClass]) {
    jobError(sim, w.src, `InvalidObjectState: The object is archived in ${ARCHIVED[o.storageClass]} and must be restored before it can be copied.`);
    return;
  }
  const dest = buckets.get(sim.req.destBucket!)!;
  if (dest.readOnly) {
    jobError(sim, w.src, DENIED_WRITE);
    return;
  }
  if (dest.objects.has(w.dest!) && sim.req.onConflict === "skip") {
    // Left untouched; in a move the source is NOT deleted.
    j.skippedItems++;
    return;
  }
  dest.objects.set(w.dest!, {
    ...o,
    metadata: { ...o.metadata },
    // Tags are carried over by a copy.
    tags: o.tags ? copyTags(o.tags) : undefined,
    lastModified: new Date().toISOString(),
    etag: hex(32),
    versionId: null,
  });
  dest.sorted = null;
  // Move: the source is deleted only after its own copy succeeded, object by object.
  if (sim.req.kind === "move") {
    if (src.readOnly) {
      j.doneBytes += o.size;
      jobError(sim, w.src, "AccessDenied: The copy exists, but the original remains: deleting it was denied.");
      return;
    }
    src.objects.delete(w.src);
    src.sorted = null;
  }
  j.doneItems++;
  j.doneBytes += o.size;
}

function jobTick() {
  let running = 0;
  let active = 0;
  for (const s of jobSims.values()) if (s.job.status === "running") running++;
  // FIFO: Map iteration order is insertion order.
  for (const s of jobSims.values()) {
    if (running >= JOB_MAX_RUNNING) break;
    if (s.job.status !== "queued") continue;
    s.job.status = "running";
    running++;
    emitJob(s.job);
  }
  for (const sim of jobSims.values()) {
    const j = sim.job;
    if (j.status === "queued") active++;
    if (j.status !== "running") continue;
    active++;
    if (j.phase === "listing") {
      if (listStep(sim, JOB_LIST_PER_TICK)) {
        if (j.error) {
          finishJob(sim, "failed");
          continue;
        }
        j.phase = "working";
      }
      emitJob(j);
      continue;
    }
    // ~16 operations in flight; scaled so large folders take a few seconds and stay visible.
    const perTick = Math.max(2, Math.ceil(sim.work.length / 45));
    for (let n = 0; n < perTick && sim.workPos < sim.work.length; n++) workOne(sim, sim.work[sim.workPos++]);
    if (sim.workPos >= sim.work.length) finishJob(sim, j.failedItems > 0 ? "failed" : "completed");
    else emitJob(j);
  }
  if (active === 0 && jobTicker) {
    clearInterval(jobTicker);
    jobTicker = null;
  }
}

// ---- the backend ---------------------------------------------------------------------

export const mockBackend: Backend = {
  async listProfiles() {
    await latency();
    return profiles.map((p) => ({ ...p }));
  },

  async connect(config: ConnectionConfig) {
    await delay(500 + rand() * 300);
    if (config.kind === "profile") {
      const p = profiles.find((x) => x.name === config.profile);
      if (!p) throw fail("InvalidInput", `Profile “${config.profile}” not found in ~/.aws/config.`);
      if (!p.hasCredentials) throw fail("Auth", `Profile “${p.name}” has no credentials. Run “aws sso login --profile ${p.name}”.`);
      connectionKey = `profile:${p.name}@${withScheme(config.endpoint) ?? (p.name === "minio-local" ? "http://localhost:9000" : "aws")}`;
      connection = {
        label: p.name,
        region: config.region || p.region || "us-east-1",
        endpoint: withScheme(config.endpoint) ?? (p.name === "minio-local" ? "http://localhost:9000" : null),
        canListBuckets: p.name !== "restricted",
      };
    } else {
      if (!config.accessKeyId.trim() || !config.secretAccessKey.trim()) {
        throw fail("InvalidInput", "Access key ID and secret access key are required.");
      }
      if (config.secretAccessKey === "bad") throw fail("Auth", "The AWS access key ID or signature you provided is invalid.");
      connectionKey = `static:${config.accessKeyId.trim()}@${withScheme(config.endpoint) ?? "aws"}`;
      connection = {
        label: config.accessKeyId.slice(0, 4) + "…" + config.accessKeyId.slice(-4),
        region: config.region || "us-east-1",
        endpoint: withScheme(config.endpoint),
        canListBuckets: true,
      };
    }
    return { ...connection };
  },

  async disconnect() {
    await delay(60);
    connection = null;
    connectionKey = null;
  },

  async connectionStatus() {
    await delay(30);
    return connection ? { ...connection } : null;
  },

  async listBuckets(): Promise<Bucket[]> {
    await latency();
    const c = requireConnection();
    if (!c.canListBuckets) throw fail("AccessDenied", "Access Denied: s3:ListAllMyBuckets is not allowed for this identity.");
    return [...buckets.entries()].filter(([, b]) => !b.hidden).map(([name, b]) => ({ name, creationDate: b.creationDate }));
  },

  async listAddedBuckets() {
    await latency();
    return addedForConnection();
  },

  async addBucket(input) {
    await delay(300 + rand() * 300);
    requireConnection();
    const parsed = parseBucketInput(typeof input === "string" ? input : "");
    if (!parsed.ok) throw fail("InvalidInput", parsed.error);
    const name = parsed.name;
    const all = loadAdded();
    const list = all[connectionKey ?? ""] ?? [];
    const existing = list.find((a) => a.name === name);
    if (existing) return { ...existing };
    if (name.includes("missing")) throw fail("NoSuchBucket", `The bucket “${name}” does not exist (HeadBucket returned 404).`);
    if (name.includes("denied")) {
      throw fail("AccessDenied", `The bucket “${name}” exists, but these credentials can’t list it (s3:ListBucket was denied).`);
    }
    if (!buckets.has(name)) {
      // Unknown to the mock: make it exist, with a few files, as if it were shared from elsewhere.
      const b = createMockBucket(name, new Date(NOW - 40 * DAY).toISOString(), { hidden: true });
      for (let i = 0; i < 5; i++) put(b, `shared/file-${i + 1}.txt`, between(1 * KB, 90 * KB), { ageDays: i });
    }
    const added: AddedBucket = {
      name,
      region: connection?.endpoint ? null : name.startsWith("vendor-") ? "eu-central-1" : (connection?.region ?? "us-east-1"),
      addedAt: new Date().toISOString(),
    };
    all[connectionKey ?? ""] = [...list, added];
    saveAdded(all);
    return { ...added };
  },

  async removeAddedBucket(name) {
    await delay(80);
    requireConnection();
    const all = loadAdded();
    const key = connectionKey ?? "";
    all[key] = (all[key] ?? []).filter((a) => a.name !== name);
    saveAdded(all);
  },

  async getBucketTags(bucket) {
    await latency();
    const b = requireBucket(bucket);
    if (tagsUnsupported(bucket)) throw notSupported();
    if (b.hidden) throw fail("AccessDenied", "Access Denied: s3:GetBucketTagging is not allowed on a bucket shared with you.");
    return copyTags(b.tags);
  },

  async putBucketTags(bucket, tags, expected) {
    await latency();
    tagCallLog.push({ cmd: "put_bucket_tags", bucket, key: null, tags: copyTags(tags), expected: copyTags(expected), at: new Date().toISOString() });
    const b = requireBucket(bucket);
    if (tagsUnsupported(bucket)) throw notSupported();
    if (b.hidden) throw fail("AccessDenied", "Access Denied: s3:PutBucketTagging is not allowed on a bucket shared with you.");
    const next = checkTagWrite(tags, expected, TAG_LIMITS.bucketMaxTags);
    if (!sameTagSet(b.tags ?? [], expected)) throw conflict();
    const f = takeInjected("tags");
    if (f && !f.write) throw fail(f.code, f.message);
    b.tags = next.length ? copyTags(next) : undefined;
    if (f) throw fail(f.code, f.message);
    return copyTags(b.tags);
  },

  async getObjectTags(bucket, key) {
    await latency();
    const b = requireBucket(bucket);
    if (tagsUnsupported(bucket)) throw notSupported();
    const o = b.objects.get(key);
    if (!o) throw fail("NoSuchKey", `The key “${key}” does not exist.`);
    return copyTags(o.tags);
  },

  async putObjectTags(bucket, key, tags, expected) {
    await latency();
    tagCallLog.push({ cmd: "put_object_tags", bucket, key, tags: copyTags(tags), expected: copyTags(expected), at: new Date().toISOString() });
    const b = requireBucket(bucket);
    if (tagsUnsupported(bucket)) throw notSupported();
    const o = b.objects.get(key);
    if (!o) throw fail("NoSuchKey", `The key “${key}” does not exist.`);
    if (b.readOnly) throw fail("AccessDenied", "Access Denied: s3:PutObjectTagging is not allowed on this bucket.");
    const next = checkTagWrite(tags, expected, TAG_LIMITS.objectMaxTags);
    if (!sameTagSet(o.tags ?? [], expected)) throw conflict();
    const f = takeInjected("tags");
    if (f && !f.write) throw fail(f.code, f.message);
    o.tags = next.length ? copyTags(next) : undefined;
    if (f) throw fail(f.code, f.message);
    return copyTags(o.tags);
  },

  async getLifecycle(bucket) {
    await latency();
    const b = requireBucket(bucket);
    if (lifecycleUnsupported(bucket)) throw lifecycleNotSupported();
    if (lifecycleDenied(bucket, b)) throw fail("AccessDenied", "Access Denied: s3:GetLifecycleConfiguration is not allowed on a bucket shared with you.");
    if (lifecycleSwitch(bucket) === "newclass") {
      throw fail(
        "Unknown",
        "This bucket's lifecycle configuration uses the storage class “GLACIER_NEXT” in rule 2 (“move-to-next”), which this version of S3 Explorer does not understand. To avoid losing it, the configuration can't be shown or changed here; use the AWS console or CLI.",
      );
    }
    return storedLifecycle(bucket);
  },

  async validateLifecycle(config) {
    await delay(15);
    return validateLifecycleConfig(cloneLc(config));
  },

  async putLifecycle(bucket, config, expected) {
    await latency();
    lifecycleCallLog.push({ cmd: "put_lifecycle", bucket, config: cloneLc(config), expected: cloneLc(expected), at: new Date().toISOString() });
    const b = requireBucket(bucket);
    if (lifecycleUnsupported(bucket)) throw lifecycleNotSupported();
    if (lifecycleDenied(bucket, b)) throw fail("AccessDenied", "Access Denied: s3:PutLifecycleConfiguration is not allowed on a bucket shared with you.");
    // "Note: …" issues are warnings (e.g. a date that has passed): they don't block saving.
    const issues = validateLifecycleConfig(config).filter((i) => !i.message.startsWith("Note: "));
    if (issues.length) {
      const parts = issues.slice(0, 10).map((i) => (i.ruleIndex === null ? i.message : `Rule ${i.ruleIndex + 1}: ${i.message}`));
      throw fail("InvalidInput", `The lifecycle configuration was not saved because it has ${issues.length} problem${issues.length === 1 ? "" : "s"}: ${parts.join(" ")}`);
    }
    const current = storedLifecycle(bucket);
    if (!sameConfiguration(current, expected)) {
      throw fail("Conflict", "The bucket's lifecycle configuration was changed by someone else since it was loaded. Nothing was saved. Reload to see the current rules.");
    }
    if (sameConfiguration(current, config)) return current;
    const mode = lifecycleSwitch(bucket);
    if (mode === "notrans" && config.rules.some((r) => r.transitions.length || r.noncurrentVersionTransitions.length)) {
      throw fail(
        "NotSupported",
        "The server refused this lifecycle configuration because it does not implement something in it (NotImplemented: A header or query you provided requested a function that is not implemented: lifecycle transitions). Nothing was changed.",
      );
    }
    if (mode === "partial") {
      const dropped = config.rules.flatMap((r, i) =>
        r.noncurrentVersionTransitions.length || r.noncurrentVersionExpiration ? [`${ruleLabel(i, r.id)}: noncurrent-version actions`] : [],
      );
      if (dropped.length) {
        throw fail(
          "NotSupported",
          `The server accepted the lifecycle configuration but did not store all of it (${dropped.join("; ")}); it probably does not support those features. The previous configuration was put back, so nothing changed.`,
        );
      }
    }
    const f = takeInjected("lifecycle");
    if (f && !f.write) throw fail(f.code, f.message);
    writeLifecycle(bucket, config.rules.length ? asStored(config) : null);
    if (f) throw fail(f.code, f.message);
    return storedLifecycle(bucket);
  },

  async getBucketVersioning(bucket) {
    await latency();
    const b = requireBucket(bucket);
    if (lifecycleDenied(bucket, b)) throw fail("AccessDenied", "Access Denied: s3:GetBucketVersioning is not allowed on a bucket shared with you.");
    return mockVersioning[bucket] ?? "Off";
  },


  async listObjects(bucket, prefix, continuationToken, pageSize): Promise<ListPage> {
    await latency();
    const b = requireBucket(bucket);
    const keys = sortedKeys(b);
    type Entry = { folder: FolderEntry } | { object: ObjectEntry } | { marker: true };
    const entries: Entry[] = [];
    let lastFolder = "";
    for (let i = lowerBound(keys, prefix); i < keys.length; i++) {
      const key = keys[i];
      if (!key.startsWith(prefix)) break;
      const rest = key.slice(prefix.length);
      if (rest === "") {
        // The folder marker counts toward the page like on real S3, but is never returned.
        entries.push({ marker: true });
        continue;
      }
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const fp = prefix + rest.slice(0, slash + 1);
        if (fp !== lastFolder) {
          entries.push({ folder: { prefix: fp, name: rest.slice(0, slash) } });
          lastFolder = fp;
        }
      } else {
        const o = b.objects.get(key)!;
        entries.push({
          object: { key, name: rest, size: o.size, lastModified: o.lastModified, etag: o.etag, storageClass: o.storageClass },
        });
      }
    }
    const start = continuationToken ? Number(atob(continuationToken)) || 0 : 0;
    const size = Math.max(1, Math.min(1000, pageSize ?? 1000));
    // Mirror a real-world quirk: a page that only contains the hidden marker comes back
    // empty but truncated. The UI must keep following the continuation token.
    const leadingMarker = start === 0 && entries.length > 1 && "marker" in entries[0];
    const slice = entries.slice(start, leadingMarker ? 1 : start + size);
    const end = start + slice.length;
    const isTruncated = end < entries.length;
    const page: ListPage = {
      folders: [],
      objects: [],
      nextContinuationToken: isTruncated ? btoa(String(end)) : null,
      isTruncated,
    };
    for (const e of slice) {
      if ("folder" in e) page.folders.push(e.folder);
      else if ("object" in e) page.objects.push(e.object);
    }
    return page;
  },

  async listRecent(bucket, prefix): Promise<RecentListing> {
    await latency();
    const b = requireBucket(bucket);
    const files = sortedKeys(b).filter((key) => key.startsWith(prefix) && !key.endsWith("/"));
    const objects = files
      .map((key): ObjectEntry => {
        const o = b.objects.get(key)!;
        return { key, name: key.slice(key.lastIndexOf("/") + 1), size: o.size, lastModified: o.lastModified, etag: o.etag, storageClass: o.storageClass };
      })
      .sort((x, y) => (y.lastModified ?? "").localeCompare(x.lastModified ?? "") || x.key.localeCompare(y.key))
      .slice(0, 200);
    return { objects, scanned: files.length, truncated: false };
  },

  async headObject(bucket, key): Promise<ObjectMeta> {
    await latency();
    const b = requireBucket(bucket);
    const o = b.objects.get(key);
    if (!o) throw fail("NoSuchKey", `The key “${key}” does not exist.`);
    const name = key.split("/").filter(Boolean).pop() ?? key;
    return {
      key,
      name,
      size: o.size,
      lastModified: o.lastModified,
      etag: o.etag,
      storageClass: o.storageClass,
      contentType: o.contentType,
      metadata: { ...o.metadata },
      versionId: o.versionId,
    };
  },

  async createFolder(bucket, prefix) {
    await latency();
    const b = requireWritable(bucket);
    if (!prefix || prefix === "/") throw fail("InvalidInput", "Folder prefix must not be empty.");
    const p = prefix.endsWith("/") ? prefix : prefix + "/";
    put(b, p, 0, { ageDays: 0 });
  },

  async startDownload(bucket, key, destPath) {
    await delay(40);
    if (!key || key.endsWith("/")) throw fail("InvalidInput", "Key must name an object, not a folder.");
    const b = requireBucket(bucket);
    const o = b.objects.get(key);
    if (!o) throw fail("NoSuchKey", `The key “${key}” does not exist.`);
    const archived = o.storageClass === "GLACIER" || o.storageClass === "DEEP_ARCHIVE";
    return startSim("download", bucket, key, destPath, o.size, archived
      ? "InvalidObjectState: The object is archived. Restore it before downloading."
      : undefined);
  },

  async startUpload(bucket, key, srcPath) {
    await delay(40);
    if (!key || key.endsWith("/")) throw fail("InvalidInput", "Key must name an object, not a folder.");
    const b = requireBucket(bucket);
    // Like S3: the upload is accepted and then fails when PutObject is denied.
    return startSim("upload", bucket, key, srcPath, fakeSize(srcPath), b.readOnly ? DENIED_WRITE : undefined);
  },

  async cancelTransfer(id) {
    await delay(30);
    const s = sims.get(id);
    if (!s) throw fail("InvalidInput", "Unknown transfer.");
    if (s.t.status === "running" || s.t.status === "queued") {
      s.t.status = "cancelled";
      s.t.bytesPerSec = 0;
      s.t.finishedAt = new Date().toISOString();
      emit(s.t);
    }
  },

  async removeTransfer(id) {
    await delay(20);
    const s = sims.get(id);
    if (s && (s.t.status === "running" || s.t.status === "queued")) {
      throw fail("InvalidInput", "Cannot remove a transfer that is still running. Cancel it first.");
    }
    sims.delete(id);
  },

  async listTransfers() {
    await delay(20);
    return [...sims.values()].map((s) => ({ ...s.t }));
  },

  async onTransferProgress(cb) {
    progressListeners.add(cb);
    return () => {
      progressListeners.delete(cb);
    };
  },

  async previewJob(request) {
    await delay(previewDelay.next ?? 250 + rand() * 350);
    previewDelay.next = null;
    logJobCall("preview_job", request);
    return previewJobSync(request);
  },

  async startJob(request) {
    await delay(60);
    logJobCall("start_job", request);
    return startJobSync(request);
  },

  async cancelJob(id) {
    await delay(30);
    const sim = jobSims.get(id);
    if (!sim) throw fail("InvalidInput", "Unknown job.");
    if (sim.job.status === "running" || sim.job.status === "queued") finishJob(sim, "cancelled");
  },

  async removeJob(id) {
    await delay(20);
    const sim = jobSims.get(id);
    if (sim && (sim.job.status === "running" || sim.job.status === "queued")) {
      throw fail("InvalidInput", "Cannot remove a job that is still running. Cancel it first.");
    }
    jobSims.delete(id);
  },

  async listJobs() {
    await delay(20);
    return [...jobSims.values()].map((s) => cloneJob(s.job));
  },

  async onJobProgress(cb) {
    jobListeners.add(cb);
    return () => {
      jobListeners.delete(cb);
    };
  },

  async getSettings() {
    await delay(30);
    return { ...settings };
  },

  async updateSettings(next) {
    await delay(120);
    const candidate: AppSettings = {
      partSizeMib: next.partSizeMib,
      maxConcurrentParts: next.maxConcurrentParts,
      maxConcurrentTransfers: next.maxConcurrentTransfers,
      theme: next.theme,
      checkUpdatesOnStartup: next.checkUpdatesOnStartup,
      notifyOnFinish: next.notifyOnFinish,
      textSize: next.textSize,
      textWeight: next.textWeight,
      accent: next.accent,
      confirmCopyMove: next.confirmCopyMove,
    };
    const problem = validateAppSettings(candidate);
    if (problem) throw fail("InvalidInput", `${problem.field}: ${problem.message}`);
    settings = candidate;
    try {
      localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable: keep in memory only */
    }
    // A raised limit starts queued transfers at once; a lowered one never interrupts running ones.
    startQueued();
    return { ...settings };
  },

  async listSavedConnections() {
    await delay(60);
    return sortConnections(savedConnections.map(withSecretFlag));
  },

  async saveConnection(input: SaveConnectionInput) {
    await delay(150);
    const name = input.name.trim();
    if (!name) throw fail("InvalidInput", "name must not be empty");
    if ([...name].length > SAVED_CONNECTION_NAME_MAX) {
      throw fail("InvalidInput", `name must be at most ${SAVED_CONNECTION_NAME_MAX} characters`);
    }
    const existing = input.id ? savedConnections.find((c) => c.id === input.id) : undefined;
    if (input.id && !existing) throw fail("InvalidInput", "That saved connection no longer exists.");
    if (savedConnections.some((c) => c.id !== input.id && c.name.toLowerCase() === name.toLowerCase())) {
      throw fail("InvalidInput", `A saved connection named “${name}” already exists.`);
    }
    const cfg = input.config;
    let secretToStore: string | null = null;
    if (cfg.kind === "static") {
      if (cfg.sessionToken && cfg.sessionToken.trim()) {
        throw fail("InvalidInput", "Temporary credentials (with a session token) can't be saved.");
      }
      if (!cfg.accessKeyId.trim()) throw fail("InvalidInput", "accessKeyId must not be empty");
      if (!cfg.region.trim()) throw fail("InvalidInput", "region must not be empty");
      if (cfg.secretAccessKey) secretToStore = cfg.secretAccessKey;
      else if (!existing) throw fail("InvalidInput", "secretAccessKey must not be empty");
    } else if (!cfg.profile.trim()) {
      throw fail("InvalidInput", "profile must not be empty");
    }
    if (name.toLowerCase().includes("keychain-fail")) {
      throw fail("Keychain", "Couldn't write to the OS keychain: the keychain is locked (mock).");
    }
    const id = existing?.id ?? crypto.randomUUID();
    const endpoint = (cfg.endpoint ?? "").trim() || null;
    const stored: StoredConnection = {
      id,
      name,
      kind: cfg.kind,
      profile: cfg.kind === "profile" ? cfg.profile : null,
      accessKeyId: cfg.kind === "static" ? cfg.accessKeyId.trim() : null,
      region: (cfg.region ?? "").trim() || null,
      endpoint,
      forcePathStyle: cfg.kind === "static" ? (cfg.forcePathStyle ?? !!endpoint) : !!endpoint,
      lastUsedAt: existing?.lastUsedAt ?? null,
    };
    if (cfg.kind === "static" && secretToStore !== null) mockKeychain.set(id, secretToStore);
    if (cfg.kind === "profile") mockKeychain.delete(id);
    savedConnections = existing ? savedConnections.map((c) => (c.id === id ? stored : c)) : [...savedConnections, stored];
    persistConnections();
    return withSecretFlag(stored);
  },

  async deleteSavedConnection(id) {
    await delay(80);
    savedConnections = savedConnections.filter((c) => c.id !== id);
    mockKeychain.delete(id);
    persistConnections();
  },

  async connectSaved(id) {
    const c = savedConnections.find((x) => x.id === id);
    if (!c) {
      await delay(60);
      throw fail("InvalidInput", "That saved connection no longer exists.");
    }
    let config: ConnectionConfig;
    if (c.kind === "profile") {
      config = { kind: "profile", profile: c.profile ?? "", region: c.region, endpoint: c.endpoint };
    } else {
      if (c.name.toLowerCase().includes("keychain-locked")) {
        await delay(200);
        throw fail("Keychain", "The OS keychain refused access (mock).");
      }
      const secret = mockKeychain.get(c.id);
      if (!secret) {
        await delay(120);
        throw fail("InvalidInput", `The secret key for “${c.name}” is missing from the keychain. Enter it again.`);
      }
      config = {
        kind: "static",
        accessKeyId: c.accessKeyId ?? "",
        secretAccessKey: secret,
        region: c.region ?? "us-east-1",
        endpoint: c.endpoint,
        forcePathStyle: c.forcePathStyle,
      };
    }
    const info = await mockBackend.connect(config);
    c.lastUsedAt = new Date().toISOString();
    persistConnections();
    connection = { ...info, label: c.name };
    connectionKey = c.id;
    return { ...connection };
  },

  async checkForUpdate() {
    await delay(700 + rand() * 500);
    const mode = mockUpdateMode();
    if (mode === "error") throw fail("Network", "Couldn't reach github.com: connection timed out (mock).");
    const available = mode === "available" || mode === "manual";
    lastUpdate = {
      currentVersion: MOCK_VERSION,
      available,
      latestVersion: available ? "0.3.1" : MOCK_VERSION,
      notes: available ? MOCK_NOTES : null,
      publishedAt: available ? new Date(NOW - 2 * DAY).toISOString() : null,
      canInstall: mode === "available",
      downloadUrl: RELEASES_URL,
    };
    return { ...lastUpdate };
  },

  async installUpdate() {
    await delay(100);
    if (!lastUpdate?.available || !lastUpdate.canInstall) {
      throw fail("InvalidInput", "No installable update is known. Check for updates first.");
    }
    for (const s of sims.values()) {
      if (s.t.status === "running" || s.t.status === "queued") {
        throw fail("InvalidInput", "Transfers are still running. Wait for them to finish or cancel them, then install the update.");
      }
    }
    for (const j of jobSims.values()) {
      if (j.job.status === "running" || j.job.status === "queued") {
        throw fail("InvalidInput", "File operations are still running. Wait for them to finish or cancel them, then install the update.");
      }
    }
    const emitUpdate = (p: UpdateProgress) => {
      for (const l of updateListeners) l({ ...p });
    };
    const total = 9_874_432;
    const steps = 30;
    for (let i = 0; i <= steps; i++) {
      emitUpdate({ phase: "downloading", downloadedBytes: Math.round((total * i) / steps), totalBytes: total });
      await delay(100);
    }
    emitUpdate({ phase: "installing", downloadedBytes: total, totalBytes: total });
    await delay(700);
    emitUpdate({ phase: "restarting", downloadedBytes: total, totalBytes: total });
    await delay(500);
    window.location.reload();
  },

  async onUpdateProgress(cb) {
    updateListeners.add(cb);
    return () => {
      updateListeners.delete(cb);
    };
  },

  async appVersion() {
    return MOCK_VERSION;
  },

  async openExternal(url) {
    console.info("[mock] open in browser:", url);
  },

  async notify(title, body) {
    console.info("[mock] desktop notification:", title, body ?? "");
  },

  async setWindowTitle(title) {
    document.title = title;
  },

  async setZoom(scale) {
    // The closest a plain browser tab offers to the webview's zoom.
    document.documentElement.style.setProperty("zoom", String(scale));
  },

  async pickFiles() {
    await delay(150);
    const n = 1 + Math.floor(Math.random() * 3);
    const shuffled = [...FAKE_FILES].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  },

  async pickSavePath(defaultName) {
    await delay(150);
    return `C:\\Users\\demo\\Downloads\\${defaultName}`;
  },

  async pickDirectory() {
    await delay(150);
    return "C:\\Users\\demo\\Downloads";
  },

  async joinPath(dir, name) {
    return dir.replace(/[\\/]+$/, "") + "\\" + name;
  },

  async revealInFolder(path) {
    console.info("[mock] reveal in folder:", path);
  },

  async onFileDrop(cb: (e: FileDropEvent) => void): Promise<Unlisten> {
    // Browser fallback for OS drag & drop: synthesize fake absolute paths from file names.
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (depth++ === 0) cb({ type: "enter", paths: [] });
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      cb({ type: "over" });
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        cb({ type: "leave" });
      }
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => `C:\\Users\\demo\\Dropped\\${f.name}`);
      cb({ type: "drop", paths });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  },
};
