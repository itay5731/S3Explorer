import { useEffect, useState } from "react";
import { Download, RefreshCw, Search, X } from "lucide-react";
import type { ObjectEntry } from "../lib/types";
import { extension, formatExact, formatRelative } from "../lib/format";
import { downloadObjects } from "../store/actions";
import { navigate, readPref, setSelection, useApp, writePref } from "../store/app";
import { loadRecent, useRecent } from "../store/recent";
import { onTransferFinished } from "../store/transfers";
import { ExtensionFilter } from "./ExtensionFilter";
import { FileIcon } from "./FileIcon";

const RANGE_KEY = "s3x.recentRange";
const HOUR_MS = 3600_000;
/** How far back "new" reaches. With none chosen there is no time limit. */
const RANGES = [
  { id: "hour", label: "1 h", hours: 1 },
  { id: "day", label: "24 h", hours: 24 },
  { id: "week", label: "7 days", hours: 24 * 7 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
const DEFAULT_RANGE: RangeId = "day";
/** How long to wait after an upload finishes before scanning again (ms). */
const RESCAN_DELAY_MS = 800;

/**
 * The lower part of the sidebar: the files most recently added to the open bucket, wherever they
 * are in it, so a fresh upload or build can be reached without browsing down to it.
 */
export function RecentFiles() {
  const bucket = useApp((s) => s.bucket);
  const recent = useRecent();
  const [filter, setFilter] = useState("");
  const [rangeId, setRangeId] = useState(() => readPref<RangeId | null>(RANGE_KEY, DEFAULT_RANGE));
  /** File extensions to show; empty means every type. */
  const [types, setTypes] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (bucket) void loadRecent(bucket);
  }, [bucket]);

  // An upload into the open bucket is new by definition: look again when one finishes. Uploads
  // often finish in bursts, so wait a moment and scan once for all of them.
  useEffect(() => {
    if (!bucket) return;
    let timer = 0;
    const stop = onTransferFinished((t) => {
      if (t.kind !== "upload" || t.status !== "completed" || t.bucket !== bucket) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadRecent(bucket), RESCAN_DELAY_MS);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [bucket]);

  /** Go to the file's folder with the file selected. The key is the server's own and is used unchanged. */
  const show = (o: ObjectEntry) => {
    if (!bucket) return;
    navigate(bucket, o.key.slice(0, o.key.length - o.name.length));
    setSelection(new Set([o.key]), o.key, o.key);
  };

  // A scan for another bucket may still be on screen for a moment after switching.
  const current = bucket !== null && recent.bucket === bucket;
  // The search looks at the whole path, so a folder name finds the files inside it.
  const wanted = filter.trim().toLowerCase();
  // No range chosen (or a saved id from an older build that no longer exists) means no time limit.
  const range = RANGES.find((r) => r.id === rangeId) ?? null;
  const since = range ? Date.now() - range.hours * HOUR_MS : null;
  // A file without a date cannot be placed in a time range, so it shows only without one.
  const inRange = recent.objects.filter(
    (o) => since === null || (o.lastModified !== null && Date.parse(o.lastModified) >= since),
  );
  const shown = inRange.filter(
    (o) => (!wanted || o.key.toLowerCase().includes(wanted)) && (types.size === 0 || types.has(extension(o.name))),
  );
  /**
   * For the type filter: how many files in the chosen time range have each extension. A chosen
   * type stays listed with 0 when the range has none of it, so it can still be unticked.
   */
  const typeCounts = new Map<string, number>([...types].map((ext) => [ext, 0]));
  for (const o of inRange) typeCounts.set(extension(o.name), (typeCounts.get(extension(o.name)) ?? 0) + 1);

  return (
    <section className="recent">
      <div className="sidebar-head">
        <span className="section-title">Newest files</span>
        {bucket && (
          <button className="icon-btn" onClick={() => void loadRecent(bucket)} title="Look again" disabled={recent.loading}>
            <RefreshCw size={13} className={recent.loading ? "spin" : ""} />
          </button>
        )}
      </div>
      {current && recent.objects.length > 0 && (
        <div className="recent-range" role="radiogroup" aria-label="How far back to look">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={r.id === range?.id}
              className={r.id === range?.id ? "active" : ""}
              title={r.id === range?.id ? "Click again to remove the time limit" : undefined}
              onClick={() => {
                // Clicking the chosen range again removes the time limit.
                const next = r.id === range?.id ? null : r.id;
                setRangeId(next);
                writePref(RANGE_KEY, next);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      {current && recent.objects.length > 0 && (
        <div className="recent-filters">
          <div className="search-box">
            <Search size={13} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search" spellCheck={false} />
            {filter && (
              <button className="icon-btn" onClick={() => setFilter("")} aria-label="Clear search">
                <X size={12} />
              </button>
            )}
          </div>
          <ExtensionFilter counts={typeCounts} selected={types} onChange={setTypes} />
        </div>
      )}
      {!bucket ? (
        <p className="recent-note">Open a bucket to see what was added to it last.</p>
      ) : !current || (recent.loading && recent.objects.length === 0) ? (
        <div className="recent-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="recent-item skeleton" />
          ))}
        </div>
      ) : recent.error ? (
        <p className="recent-note err-text">{recent.error.message}</p>
      ) : recent.objects.length === 0 ? (
        <p className="recent-note">This bucket has no files yet.</p>
      ) : shown.length === 0 ? (
        <p className="recent-note">
          {wanted || types.size ? "No file matches" : "Nothing new"}
          {range ? ` in the last ${range.label}.` : "."}
        </p>
      ) : (
        <ul className="recent-list">
          {shown.map((o) => (
            <li key={o.key} className="recent-row">
              <button
                className="recent-item"
                onClick={() => show(o)}
                title={`${o.key}\n${formatExact(o.lastModified)}`}
              >
                <FileIcon name={o.name} size={14} />
                <span className="recent-text">
                  <span className="recent-name">{o.name}</span>
                  {/* The folder the file is in: its key without the file name. */}
                  <span className="recent-path">{o.key.slice(0, o.key.length - o.name.length) || "Top of the bucket"}</span>
                </span>
                <span className="recent-when">{formatRelative(o.lastModified)}</span>
              </button>
              <button
                className="icon-btn recent-download"
                onClick={() => void downloadObjects([o])}
                aria-label={`Download ${o.name}`}
                title="Download"
              >
                <Download size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && recent.truncated && (
        <p className="recent-note">Only the first 20,000 files were checked, so newer ones may be missing.</p>
      )}
    </section>
  );
}
