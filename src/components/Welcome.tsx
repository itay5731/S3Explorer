import { useApp } from "../store/app";
import { plural } from "../lib/ops";

/** The main area before a bucket is opened: a large picture, what to do next, and what a bucket offers. */
export function Welcome() {
  const connection = useApp((s) => s.connection);
  const bucketCount = useApp((s) => s.buckets.length);
  if (!connection) return null;

  return (
    <div className="welcome">
      {/* A file dropping into a bucket. */}
      <svg className="welcome-art" viewBox="0 0 200 170" aria-hidden="true">
        <g className="welcome-file" transform="rotate(-8 100 26)">
          <rect x="84" y="6" width="32" height="40" rx="5" />
          <path d="M91 18h18M91 26h18M91 34h11" />
        </g>
        <path className="welcome-bucket" d="M48 72 60 142c1 10 18 16 40 16s39-6 40-16l12-70" />
        <ellipse className="welcome-bucket" cx="100" cy="72" rx="52" ry="14" />
        <path className="welcome-bucket" d="M53 100c8 8 26 12 47 12s39-4 47-12M57 124c8 7 24 11 43 11s35-4 43-11" />
      </svg>
      <h1>Pick a bucket</h1>
      <p className="welcome-lead">
        {connection.canListBuckets
          ? `${connection.label} has ${plural(bucketCount, "bucket")}. Choose one from the list on the left to browse its files.`
          : `${connection.label} is not allowed to list its buckets. Add one by name on the left to browse its files.`}
      </p>
      <p className="muted">
        Inside a bucket you can drop files in to upload them, download what you select, and copy or move things between
        folders.
      </p>
    </div>
  );
}
