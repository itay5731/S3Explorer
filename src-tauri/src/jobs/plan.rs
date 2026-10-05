//! Pure planning helpers for jobs: prefix expansion and destination mapping, de-duplication,
//! collision checks, the `x-amz-copy-source` encoder, multipart-copy part planning and labels.

use std::collections::{HashMap, HashSet};

use crate::models::{last_segment, JobError, JobItem, JobKind, JobRequest};

pub const MIB: u64 = 1024 * 1024;
pub const GIB: u64 = 1024 * MIB;
/// Largest object `CopyObject` accepts; larger ones use multipart copy.
pub const COPY_OBJECT_MAX: u64 = 5 * GIB;
/// Starting part size for multipart copy (doubled until the object fits in 10,000 parts).
pub const COPY_PART_SIZE: u64 = 256 * MIB;
/// S3 limits for `UploadPartCopy`.
pub const MIN_PART_SIZE: u64 = 5 * MIB;
pub const MAX_PART_SIZE: u64 = 5 * GIB;
pub const MAX_PARTS: u64 = 10_000;

/// One object as seen by a listing or a `HeadObject`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub key: String,
    pub size: u64,
    /// The ETag exactly as the server sent it (with quotes), used for `If-Match` conditions.
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

/// What the listing phase found for one request item.
#[derive(Debug, Clone)]
pub enum ItemListing {
    /// Every key under the prefix (no delimiter).
    Prefix(Vec<Listed>),
    /// A single object item that was looked up; `None` = it does not exist.
    Object(Option<Listed>),
    /// A single object item that was not looked up (delete: deleting a missing key is a no-op).
    Unchecked,
}

/// One object the job will process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub src: String,
    /// `None` for delete.
    pub dest: Option<String>,
    pub size: u64,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    /// Index of the request item that produced it.
    pub item: usize,
}

/// The destination of `key` reached through `item` (`from + rest -> to + rest` for prefixes).
/// `None` for delete, or when `key` is not under the item's prefix (never happens for keys the
/// listing returned; such keys are dropped, never mapped).
pub fn map_dest(item: &JobItem, key: &str) -> Option<String> {
    let to = item.to.as_deref()?;
    if item.is_prefix {
        let rest = key.strip_prefix(item.from.as_str())?;
        Some(format!("{to}{rest}"))
    } else if key == item.from {
        Some(to.to_string())
    } else {
        None
    }
}

/// The result of expanding every item, in request order, each source key once.
#[derive(Debug, Default)]
pub struct Expansion {
    pub work: Vec<Planned>,
    /// Items that matched nothing (unmatched prefix, missing object for copy/move).
    pub missing: Vec<JobError>,
    seen: HashSet<String>,
    seen_missing: HashSet<(bool, String)>,
}

pub const NOTHING_UNDER_PREFIX: &str = "No objects found under this prefix.";
pub const SOURCE_MISSING: &str = "NoSuchKey: The source object does not exist.";

impl Expansion {
    /// Adds one item's listing. Call in request order: the first item reaching a key wins.
    pub fn add(&mut self, idx: usize, item: &JobItem, kind: JobKind, listing: ItemListing) {
        let push = |l: Listed, me: &mut Self| {
            if me.seen.contains(&l.key) {
                return;
            }
            let dest = match kind {
                JobKind::Delete => None,
                _ => match map_dest(item, &l.key) {
                    Some(d) => Some(d),
                    None => return, // not under this item: never touch it
                },
            };
            me.seen.insert(l.key.clone());
            me.work.push(Planned { src: l.key, dest, size: l.size, etag: l.etag, storage_class: l.storage_class, item: idx });
        };
        match listing {
            ItemListing::Prefix(keys) => {
                // Defensive: only keys really under the prefix are ever processed.
                let keys: Vec<Listed> = keys.into_iter().filter(|l| l.key.starts_with(item.from.as_str())).collect();
                if keys.is_empty() {
                    if self.seen_missing.insert((true, item.from.clone())) {
                        self.missing.push(JobError { key: item.from.clone(), message: NOTHING_UNDER_PREFIX.into() });
                    }
                    return;
                }
                for l in keys {
                    push(l, self);
                }
            }
            ItemListing::Object(Some(l)) if l.key == item.from => push(l, self),
            ItemListing::Object(_) => {
                if !self.seen.contains(&item.from) && self.seen_missing.insert((false, item.from.clone())) {
                    self.missing.push(JobError { key: item.from.clone(), message: SOURCE_MISSING.into() });
                }
            }
            ItemListing::Unchecked => {
                push(Listed { key: item.from.clone(), size: 0, etag: None, storage_class: None }, self)
            }
        }
    }

    pub fn bytes(&self) -> u64 {
        self.work.iter().map(|p| p.size).sum()
    }
}

/// After expansion: every destination key must be written by exactly one source, and within
/// one bucket no destination may also be a source (a move would otherwise delete what it wrote).
/// Returns the job-level error message.
pub fn check_collisions(work: &[Planned], same_bucket: bool) -> Result<(), String> {
    let mut by_dest: HashMap<&str, &str> = HashMap::with_capacity(work.len());
    for p in work {
        let Some(d) = p.dest.as_deref() else { continue };
        if let Some(other) = by_dest.insert(d, &p.src) {
            return Err(format!(
                "Two source objects would be written to the same destination key {d:?} ({other:?} and {:?}). Nothing was changed.",
                p.src
            ));
        }
    }
    if same_bucket {
        let sources: HashSet<&str> = work.iter().map(|p| p.src.as_str()).collect();
        if let Some(p) = work.iter().find(|p| p.dest.as_deref().is_some_and(|d| sources.contains(d))) {
            return Err(format!(
                "The destination key {:?} is also a source of this job. Nothing was changed.",
                p.dest.as_deref().unwrap_or_default()
            ));
        }
    }
    Ok(())
}

/// The `x-amz-copy-source` value for `bucket/key`.
///
/// S3 URL-decodes this header and splits it at the first `/`, so every byte of the key except
/// unreserved characters (`A-Z a-z 0-9 - _ . ~`) and `/` is percent-encoded from its UTF-8
/// bytes. This matches what the AWS CLI/botocore send. Unencoded, `?` would start a query
/// (`?versionId=` selects another version!), `#` would end the value, `%` would be decoded
/// twice and `+` could become a space: each copies the wrong object or fails.
pub fn encode_copy_source(bucket: &str, key: &str) -> String {
    let mut out = String::with_capacity(bucket.len() + key.len() * 3 + 1);
    encode_into(&mut out, bucket);
    out.push('/');
    encode_into(&mut out, key);
    out
}

fn encode_into(out: &mut String, s: &str) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0xF) as usize] as char);
        }
    }
}

/// Byte ranges (inclusive) for a multipart copy of `size` bytes: `base` (at least 5 MiB),
/// doubled until the object fits in 10,000 parts, at most 5 GiB per part.
pub fn plan_copy_parts(size: u64, base: u64) -> Result<Vec<(u64, u64)>, String> {
    if size == 0 {
        return Err("Cannot multipart-copy an empty object".into());
    }
    let mut part = base.max(MIN_PART_SIZE);
    while size.div_ceil(part) > MAX_PARTS {
        part = part.saturating_mul(2);
    }
    if part > MAX_PART_SIZE {
        return Err(format!("The object is too large to copy ({size} bytes)"));
    }
    let mut ranges = Vec::with_capacity(size.div_ceil(part) as usize);
    let mut start = 0;
    while start < size {
        let end = (start + part).min(size) - 1;
        ranges.push((start, end));
        start = end + 1;
    }
    Ok(ranges)
}

/// The leaf name of a key or folder prefix as shown in labels ("a/b/" -> "b", "a/x.txt" -> "x.txt").
/// Falls back to the whole string when the leaf is empty (e.g. "a//").
fn leaf(s: &str) -> String {
    let l = last_segment(s);
    if l.is_empty() {
        s.to_string()
    } else {
        l
    }
}

/// Everything up to and including the last `/` before the leaf ("a/b/" -> "a/", "a/x" -> "a/").
fn parent(s: &str) -> &str {
    let trimmed = s.strip_suffix('/').unwrap_or(s);
    match trimmed.rfind('/') {
        Some(i) => &s[..=i],
        None => "",
    }
}

fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The job label shown in the UI: `Delete N items`, `Copy N items to <bucket>/<prefix>`,
/// `Move N items to <bucket>/<prefix>`, `Rename <old> to <new>` (single-item move within one
/// folder). A single item is named instead of counted.
pub fn label(req: &JobRequest) -> String {
    let n = req.items.len();
    let Some(first) = req.items.first() else { return String::new() };
    let what = if n == 1 { leaf(&first.from) } else { format!("{} items", thousands(n)) };
    let verb = match req.kind {
        JobKind::Delete => return format!("Delete {what}"),
        JobKind::Copy => "Copy",
        JobKind::Move => "Move",
    };
    let to = first.to.as_deref().unwrap_or_default();
    if n == 1
        && req.kind == JobKind::Move
        && req.dest_bucket.as_deref() == Some(req.src_bucket.as_str())
        && parent(to) == parent(&first.from)
    {
        return format!("Rename {what} to {}", leaf(to));
    }
    format!("{verb} {what} to {}/{}", req.dest_bucket.as_deref().unwrap_or_default(), parent(to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConflictPolicy;

    fn l(key: &str, size: u64) -> Listed {
        Listed { key: key.into(), size, etag: Some(format!("\"{key}\"")), storage_class: None }
    }
    fn item(from: &str, to: Option<&str>, is_prefix: bool) -> JobItem {
        JobItem { from: from.into(), to: to.map(Into::into), is_prefix }
    }

    #[test]
    fn mapping() {
        let it = item("a/", Some("b/c/"), true);
        assert_eq!(map_dest(&it, "a/").as_deref(), Some("b/c/"), "marker maps to marker");
        assert_eq!(map_dest(&it, "a/x").as_deref(), Some("b/c/x"));
        assert_eq!(map_dest(&it, "a//x").as_deref(), Some("b/c//x"), "no normalization");
        assert_eq!(map_dest(&it, "a/ ü+%2F?#").as_deref(), Some("b/c/ ü+%2F?#"));
        assert_eq!(map_dest(&it, "ab/x"), None, "not under the prefix");
        assert_eq!(map_dest(&it, "A/x"), None, "case sensitive");
        let o = item("k", Some("z"), false);
        assert_eq!(map_dest(&o, "k").as_deref(), Some("z"));
        assert_eq!(map_dest(&o, "k2"), None);
        assert_eq!(map_dest(&item("k", None, false), "k"), None);
    }

    #[test]
    fn expansion_dedups_in_request_order() {
        let items = [item("a/", Some("x/"), true), item("a/b", Some("y"), false), item("a/", Some("z/"), true)];
        let mut e = Expansion::default();
        e.add(0, &items[0], JobKind::Copy, ItemListing::Prefix(vec![l("a/", 0), l("a/b", 5), l("a/c", 7)]));
        e.add(1, &items[1], JobKind::Copy, ItemListing::Object(Some(l("a/b", 5))));
        e.add(2, &items[2], JobKind::Copy, ItemListing::Prefix(vec![l("a/", 0), l("a/b", 5), l("a/c", 7)]));
        let got: Vec<(&str, Option<&str>)> = e.work.iter().map(|p| (p.src.as_str(), p.dest.as_deref())).collect();
        assert_eq!(got, vec![("a/", Some("x/")), ("a/b", Some("x/b")), ("a/c", Some("x/c"))]);
        assert!(e.missing.is_empty());
        assert_eq!(e.bytes(), 12);
        assert!(check_collisions(&e.work, true).is_ok());
    }

    #[test]
    fn expansion_missing_and_foreign_keys() {
        let mut e = Expansion::default();
        let p = item("foo/", Some("bar/"), true);
        // A server that returned a key outside the prefix: dropped, never processed.
        e.add(0, &p, JobKind::Move, ItemListing::Prefix(vec![l("foobar/x", 1), l("foo", 1)]));
        assert!(e.work.is_empty());
        assert_eq!(e.missing, vec![JobError { key: "foo/".into(), message: NOTHING_UNDER_PREFIX.into() }]);
        // The same unmatched prefix twice counts once.
        e.add(1, &p, JobKind::Move, ItemListing::Prefix(vec![]));
        assert_eq!(e.missing.len(), 1);
        let o = item("k", Some("k2"), false);
        e.add(2, &o, JobKind::Copy, ItemListing::Object(None));
        e.add(3, &o, JobKind::Copy, ItemListing::Object(None));
        assert_eq!(e.missing.len(), 2);
        assert_eq!(e.missing[1].message, SOURCE_MISSING);
        // A HEAD answer for a different key is treated as missing.
        let o2 = item("q", Some("q2"), false);
        e.add(4, &o2, JobKind::Copy, ItemListing::Object(Some(l("Q", 1))));
        assert_eq!(e.missing.len(), 3);
        assert!(e.work.is_empty());
    }

    #[test]
    fn expansion_delete() {
        let mut e = Expansion::default();
        e.add(0, &item("k", None, false), JobKind::Delete, ItemListing::Unchecked);
        e.add(1, &item("k", None, false), JobKind::Delete, ItemListing::Unchecked);
        e.add(2, &item("d/", None, true), JobKind::Delete, ItemListing::Prefix(vec![l("d/", 0), l("d/k", 3), l("d//x", 1)]));
        let got: Vec<(&str, Option<&str>)> = e.work.iter().map(|p| (p.src.as_str(), p.dest.as_deref())).collect();
        assert_eq!(got, vec![("k", None), ("d/", None), ("d/k", None), ("d//x", None)]);
        assert!(check_collisions(&e.work, true).is_ok());
    }

    #[test]
    fn collisions() {
        let p = |src: &str, dest: &str| Planned {
            src: src.into(),
            dest: Some(dest.into()),
            size: 0,
            etag: None,
            storage_class: None,
            item: 0,
        };
        assert!(check_collisions(&[p("a", "x"), p("b", "y")], true).is_ok());
        let e = check_collisions(&[p("a", "x"), p("b", "x")], false).expect_err("dup dest");
        assert!(e.contains("same destination key \"x\""), "{e}");
        assert!(check_collisions(&[p("a", "b"), p("b", "c")], false).is_ok(), "other bucket");
        let e = check_collisions(&[p("a", "b"), p("b", "c")], true).expect_err("dest is a source");
        assert!(e.contains("also a source"), "{e}");
        // Byte-for-byte keys: these are all different.
        assert!(check_collisions(&[p("1", "x"), p("2", "X"), p("3", "x "), p("4", "x/"), p("5", "x//")], true).is_ok());
    }

    #[test]
    fn copy_source_encoding() {
        let e = encode_copy_source;
        assert_eq!(e("bkt", "a/b.txt"), "bkt/a/b.txt");
        assert_eq!(e("bkt", "a b"), "bkt/a%20b");
        assert_eq!(e("bkt", "a+b"), "bkt/a%2Bb");
        assert_eq!(e("bkt", "100%"), "bkt/100%25");
        assert_eq!(e("bkt", "a%2Fb"), "bkt/a%252Fb");
        assert_eq!(e("bkt", "q?versionId=x"), "bkt/q%3FversionId%3Dx");
        assert_eq!(e("bkt", "h#1"), "bkt/h%231");
        assert_eq!(e("bkt", "/lead"), "bkt//lead");
        assert_eq!(e("bkt", "trail/"), "bkt/trail/");
        assert_eq!(e("bkt", "a//b"), "bkt/a//b");
        assert_eq!(e("bkt", "a/../b"), "bkt/a/../b");
        assert_eq!(e("bkt", "ü"), "bkt/%C3%BC");
        assert_eq!(e("bkt", "日本"), "bkt/%E6%97%A5%E6%9C%AC");
        assert_eq!(e("bkt", "😀"), "bkt/%F0%9F%98%80");
        assert_eq!(e("bkt", "a&b=c;d,e:f@g$h!i'j(k)l*m"), "bkt/a%26b%3Dc%3Bd%2Ce%3Af%40g%24h%21i%27j%28k%29l%2Am");
        assert_eq!(e("bkt", "tab\there\nnl\\bs\"q<>|^`{}[]"), "bkt/tab%09here%0Anl%5Cbs%22q%3C%3E%7C%5E%60%7B%7D%5B%5D");
        assert_eq!(e("bkt", "Az09-_.~"), "bkt/Az09-_.~");
        assert_eq!(e("my.bucket-1", "k"), "my.bucket-1/k");
        // Round trip: decoding gives back the exact bytes for every byte value.
        let all: String = (1u8..=127).map(|b| b as char).chain("é€😀".chars()).collect();
        let enc = e("b", &all);
        assert!(enc.bytes().all(|b| b.is_ascii_graphic()), "header-safe: {enc}");
        assert_eq!(percent_decode(&enc), format!("b/{all}"));
    }

    fn percent_decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' {
                let h = u8::from_str_radix(&s[i + 1..i + 3], 16).expect("hex");
                out.push(h);
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).expect("utf8")
    }

    #[test]
    fn part_planning() {
        let check = |size: u64, base: u64| {
            let r = plan_copy_parts(size, base).expect("plan");
            assert!(r.len() as u64 <= MAX_PARTS);
            assert_eq!(r[0].0, 0);
            assert_eq!(r.last().map(|x| x.1), Some(size - 1));
            for w in r.windows(2) {
                assert_eq!(w[0].1 + 1, w[1].0, "contiguous");
            }
            let sizes: Vec<u64> = r.iter().map(|(a, b)| b - a + 1).collect();
            let first = sizes[0];
            assert!(sizes[..sizes.len() - 1].iter().all(|s| *s == first), "equal non-final parts");
            assert!(sizes.iter().all(|s| *s <= MAX_PART_SIZE));
            if r.len() > 1 {
                assert!(first >= MIN_PART_SIZE);
            }
            (r.len() as u64, first)
        };
        // 6 GiB at 256 MiB = 24 parts.
        assert_eq!(check(6 * GIB, COPY_PART_SIZE), (24, 256 * MIB));
        assert_eq!(check(5 * GIB + 1, COPY_PART_SIZE), (21, 256 * MIB));
        // Exactly 10,000 parts of 256 MiB still fits; one more byte doubles.
        assert_eq!(check(10_000 * 256 * MIB, COPY_PART_SIZE), (10_000, 256 * MIB));
        assert_eq!(check(10_000 * 256 * MIB + 1, COPY_PART_SIZE), (5_000 + 1, 512 * MIB));
        // 5 TiB (the S3 maximum) needs 1 GiB parts: 512 MiB would be 10,240 parts.
        assert_eq!(check(5 * 1024 * GIB, COPY_PART_SIZE), (5_120, GIB));
        // Test override: tiny base is raised to the 5 MiB minimum.
        assert_eq!(check(40 * MIB, MIB), (8, 5 * MIB));
        assert_eq!(check(40 * MIB + 1, 5 * MIB), (9, 5 * MIB));
        assert_eq!(check(1, 5 * MIB), (1, 1));
        assert!(plan_copy_parts(0, COPY_PART_SIZE).is_err());
        assert!(plan_copy_parts(u64::MAX, COPY_PART_SIZE).is_err());
    }

    fn req(kind: JobKind, src: &str, dest: Option<&str>, items: Vec<JobItem>) -> JobRequest {
        JobRequest {
            kind,
            src_bucket: src.into(),
            dest_bucket: dest.map(Into::into),
            items,
            on_conflict: ConflictPolicy::Skip,
        }
    }

    #[test]
    fn labels() {
        assert_eq!(label(&req(JobKind::Delete, "b", None, vec![item("p/x.txt", None, false)])), "Delete x.txt");
        assert_eq!(label(&req(JobKind::Delete, "b", None, vec![item("p/d/", None, true)])), "Delete d");
        assert_eq!(label(&req(JobKind::Delete, "b", None, vec![item("a//", None, true)])), "Delete a//");
        let many: Vec<JobItem> = (0..1234).map(|i| item(&format!("k{i}"), None, false)).collect();
        assert_eq!(label(&req(JobKind::Delete, "b", None, many)), "Delete 1,234 items");
        assert_eq!(
            label(&req(JobKind::Move, "b", Some("b"), vec![item("p/old.txt", Some("p/new.txt"), false)])),
            "Rename old.txt to new.txt"
        );
        assert_eq!(label(&req(JobKind::Move, "b", Some("b"), vec![item("p/a/", Some("p/b/"), true)])), "Rename a to b");
        assert_eq!(label(&req(JobKind::Move, "b", Some("b"), vec![item("top", Some("top2"), false)])), "Rename top to top2");
        assert_eq!(
            label(&req(JobKind::Move, "b", Some("b"), vec![item("p/a/", Some("q/a/"), true)])),
            "Move a to b/q/"
        );
        assert_eq!(
            label(&req(JobKind::Move, "b", Some("c"), vec![item("p/a", Some("p/a"), false)])),
            "Move a to c/p/"
        );
        assert_eq!(
            label(&req(
                JobKind::Copy,
                "b",
                Some("backups"),
                vec![item("p/a", Some("2026/a"), false), item("p/b/", Some("2026/b/"), true), item("p/c", Some("2026/c"), false)]
            )),
            "Copy 3 items to backups/2026/"
        );
        assert_eq!(label(&req(JobKind::Copy, "b", Some("c"), vec![item("a", Some("a"), false)])), "Copy a to c/");
    }

    #[test]
    fn helpers() {
        assert_eq!(parent("a/b/"), "a/");
        assert_eq!(parent("a/b"), "a/");
        assert_eq!(parent("a"), "");
        assert_eq!(parent("a/"), "");
        assert_eq!(parent("a//"), "a/");
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1000), "1,000");
        assert_eq!(thousands(10000), "10,000");
        assert_eq!(thousands(1234567), "1,234,567");
    }
}
