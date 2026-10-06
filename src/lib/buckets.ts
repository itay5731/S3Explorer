// Pure helpers for buckets added by name ("Shared with me", see "Shared buckets" in docs/CONTRACT.md).
// The backend parses `add_bucket`'s input itself; this mirror only shows the user, before adding,
// which bucket their text names. The text is sent to the backend as typed (trimmed).

export type BucketInputKind = "name" | "uri" | "arn" | "accessPoint";

export type ParsedBucketInput =
  | { ok: true; name: string; kind: BucketInputKind }
  | { ok: false; error: string };

/** Bucket names: 3 to 63 characters; letters, numbers, dots, hyphens (underscores for legacy buckets). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/;

function checkName(name: string, kind: BucketInputKind): ParsedBucketInput {
  if (!name) return { ok: false, error: "The bucket name is missing." };
  if (name.length < 3 || name.length > 63) return { ok: false, error: "A bucket name has 3 to 63 characters." };
  if (!NAME_RE.test(name)) {
    return { ok: false, error: "A bucket name has only letters, numbers, dots and hyphens, and starts and ends with a letter or number." };
  }
  return { ok: true, name, kind };
}

/**
 * What bucket `input` names: a bare name, `s3://name/any/path` (the path is ignored), a bucket ARN
 * `arn:aws:s3:::name`, or an access point ARN (kept whole, as the backend uses it as the bucket value).
 */
export function parseBucketInput(input: string): ParsedBucketInput {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter a bucket name, an s3:// address or an ARN." };
  if (/^s3:\/\//i.test(text)) {
    const name = text.slice(5).split("/")[0];
    return checkName(name, "uri");
  }
  if (/^arn:/i.test(text)) {
    const parts = text.split(":");
    // arn:partition:service:region:account:resource
    if (parts.length < 6 || parts[2] !== "s3") return { ok: false, error: "This ARN doesn't name an S3 bucket." };
    const resource = parts.slice(5).join(":");
    if (!parts[3] && !parts[4]) return checkName(resource.split("/")[0], "arn");
    if (/^accesspoint[/:]/.test(resource)) return { ok: true, name: text, kind: "accessPoint" };
    return { ok: false, error: "This ARN doesn't name a bucket or an access point." };
  }
  if (/[\s/]/.test(text)) return { ok: false, error: "A bucket name can't contain spaces or “/”." };
  return checkName(text, "name");
}
