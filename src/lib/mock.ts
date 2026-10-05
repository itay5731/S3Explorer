// In-memory fake backend used when the UI runs in a plain browser (`npm run dev`).
// Simulates a realistic account: a handful of buckets, nested folders, a folder with
// 5,000 objects, paged listing with continuation tokens and transfers with live progress.

import type { Backend, FileDropEvent, Unlisten } from "./api";
import type {
  AppError,
  Bucket,
  ConnectionConfig,
  ConnectionInfo,
  ErrorCode,
  FolderEntry,
  ListPage,
  ObjectEntry,
  ObjectMeta,
  ProfileInfo,
  Transfer,
} from "./types";

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
}

interface MockBucket {
  creationDate: string;
  objects: Map<string, MockObject>;
  sorted: string[] | null; // cache, invalidated on mutation
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

function addBucket(name: string, created: string): MockBucket {
  const b: MockBucket = { creationDate: created, objects: new Map(), sorted: null };
  buckets.set(name, b);
  return b;
}

function put(
  b: MockBucket,
  key: string,
  size: number,
  opts: { ageDays?: number; storageClass?: string; metadata?: Record<string, string> } = {},
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
  });
  b.sorted = null;
}

function seed() {
  // 1. acme-prod-assets: mixed media, unicode names, nested folders
  const assets = addBucket("acme-prod-assets", "2021-03-14T09:12:44Z");
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

  // 2. acme-logs: the 5,000-object folder (virtualization stress test)
  const logs = addBucket("acme-logs", "2022-07-01T00:00:00Z");
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
  put(logs, "README.txt", 1_204, { ageDays: 800 });
  put(logs, "cloudfront/", 0, { ageDays: 900 });
  put(logs, "cloudfront/2026-10/", 0, { ageDays: 31 });

  // 3. data-lake-raw: partitioned parquet
  const lake = addBucket("data-lake-raw", "2023-02-10T15:30:00Z");
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
  const web = addBucket("website-static", "2020-11-02T08:00:00Z");
  for (const f of ["index.html", "about.html", "pricing.html", "404.html", "sitemap.xml"]) put(web, f, between(2 * KB, 80 * KB));
  for (let i = 0; i < 18; i++) put(web, `assets/js/chunk-${hex(8)}.js`, between(10 * KB, 900 * KB));
  for (let i = 0; i < 6; i++) put(web, `assets/css/style-${hex(8)}.css`, between(5 * KB, 120 * KB));
  for (const f of ["inter-var.woff2", "jetbrains-mono.woff2"]) put(web, `assets/fonts/${f}`, between(80 * KB, 400 * KB));

  // 5. backups-archive: cold storage
  const backups = addBucket("backups-archive", "2019-05-20T22:10:00Z");
  for (let i = 0; i < 26; i++) {
    put(backups, `postgres/prod/pg_dump_2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + i).padStart(2, "0")}.sql.gz`, between(2 * GB, 14 * GB), {
      storageClass: i < 20 ? "DEEP_ARCHIVE" : "GLACIER",
      ageDays: 300 - i * 10,
    });
  }
  for (let i = 0; i < 12; i++) put(backups, `configs/etc-${2025 + Math.floor(i / 6)}-${i}.tar`, between(1 * MB, 30 * MB), { storageClass: "GLACIER_IR" });
}
seed();

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

function tick() {
  const now = Date.now();
  let running = 0;
  for (const s of sims.values()) if (s.t.status === "running") running++;
  for (const s of sims.values()) {
    if (s.t.status === "queued" && running < 4) {
      s.t.status = "running";
      s.startedMs = now;
      running++;
      emit(s.t);
    }
  }
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
      next = s.t.totalBytes <= 8 * MB ? 0 : Math.max(prev, Math.floor(next / s.partSize) * s.partSize);
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
  const partSize = size > 1 * GB ? 16 * MB : 8 * MB;
  const t: Transfer = {
    id,
    kind,
    bucket,
    key,
    localPath,
    totalBytes: size,
    transferredBytes: 0,
    partsTotal: size > 8 * MB ? Math.ceil(size / partSize) : 1,
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
  },

  async connectionStatus() {
    await delay(30);
    return connection ? { ...connection } : null;
  },

  async listBuckets(): Promise<Bucket[]> {
    await latency();
    const c = requireConnection();
    if (!c.canListBuckets) throw fail("AccessDenied", "Access Denied: s3:ListAllMyBuckets is not allowed for this identity.");
    return [...buckets.entries()].map(([name, b]) => ({ name, creationDate: b.creationDate }));
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
    const b = requireBucket(bucket);
    if (!prefix || prefix === "/") throw fail("InvalidInput", "Folder prefix must not be empty.");
    const p = prefix.endsWith("/") ? prefix : prefix + "/";
    put(b, p, 0, { ageDays: 0 });
  },

  async deleteFolder(bucket, prefix) {
    await delay(400 + rand() * 600);
    const b = requireBucket(bucket);
    if (!prefix || prefix === "/") throw fail("InvalidInput", "Refusing to delete the whole bucket.");
    if (!prefix.endsWith("/")) prefix += "/";
    let deleted = 0;
    for (const key of [...b.objects.keys()]) {
      if (key.startsWith(prefix)) {
        b.objects.delete(key);
        deleted++;
      }
    }
    b.sorted = null;
    return { deleted, errors: [] };
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
    requireBucket(bucket);
    return startSim("upload", bucket, key, srcPath, fakeSize(srcPath));
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
