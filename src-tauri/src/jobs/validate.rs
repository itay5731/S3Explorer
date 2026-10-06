//! Request-time validation of a [`JobRequest`] (pure; nothing touches S3).
//!
//! Keys and prefixes are opaque: they are compared byte for byte, never trimmed, normalized or
//! case folded. `a//`, `/a/` and `a/../b` are ordinary, distinct strings here.
//!
//! Rules (each is `InvalidInput`, and nothing is changed):
//! - `srcBucket` empty; `items` empty or more than [`JOB_MAX_ITEMS`];
//! - delete/tag: `destBucket` or any `to` present; copy/move: `destBucket` or any `to` missing;
//! - tag: `tags` missing or invalid (see [`crate::tags::validate_operation`]); other kinds: `tags`
//!   present;
//! - an empty `from`; a prefix item whose `from` (or, for copy/move, `to`) does not end in `/`
//!   or is `""` / `"/"`; an object destination that is empty or ends in `/`;
//! - same bucket: a destination equal to its source, or a prefix copied/moved into itself or a
//!   descendant (`to` starts with `from`);
//! - two items whose destinations overlap: identical `to` values, or a destination inside
//!   another item's destination prefix;
//! - same bucket: any destination range that overlaps any source range (of the same or another
//!   item). Such a job would write over objects it is still reading, and a move would then
//!   delete the object it just wrote. This is stricter than the contract's list and is what
//!   guarantees that no move ever deletes a key it also wrote.

use crate::error::{AppError, AppResult};
use crate::models::{JobKind, JobRequest, JOB_MAX_ITEMS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Src = 0,
    Dest = 1,
}

/// A key range: one exact key (`prefix == false`) or every key starting with `s`.
#[derive(Debug, Clone, Copy)]
struct Range<'a> {
    s: &'a str,
    prefix: bool,
    side: Side,
    item: usize,
}

fn other(side: Side) -> usize {
    match side {
        Side::Src => Side::Dest as usize,
        Side::Dest => Side::Src as usize,
    }
}

/// Finds two ranges that share at least one possible key. With `cross_only`, only a source and
/// a destination count as a conflict (two overlapping sources are fine: they are de-duplicated).
///
/// Sorted byte-wise (prefix before object on equal strings), every range that contains a later
/// string `e` is a prefix of `e` and sits on the stack of open prefixes; equal object keys are
/// adjacent. Each stack entry carries the first source / destination at or below it, so every
/// step is O(1) apart from popping.
fn find_overlap<'a>(mut ranges: Vec<Range<'a>>, cross_only: bool) -> Option<(Range<'a>, Range<'a>)> {
    ranges.sort_by(|a, b| {
        a.s.as_bytes().cmp(b.s.as_bytes()).then(b.prefix.cmp(&a.prefix)).then(a.item.cmp(&b.item))
    });
    type Seen = [Option<usize>; 2];
    let mut stack: Vec<(usize, Seen)> = Vec::new();
    let mut run: Option<(&str, Seen)> = None; // equal object keys
    for (i, e) in ranges.iter().enumerate() {
        while let Some(&(t, _)) = stack.last() {
            if e.s.as_bytes().starts_with(ranges[t].s.as_bytes()) {
                break;
            }
            stack.pop();
        }
        let in_stack: Seen = stack.last().map(|x| x.1).unwrap_or([None, None]);
        let in_run: Seen = match &run {
            Some((s, seen)) if !e.prefix && *s == e.s => *seen,
            _ => [None, None],
        };
        let partner = |seen: Seen| if cross_only { seen[other(e.side)] } else { seen[0].or(seen[1]) };
        if let Some(j) = partner(in_stack).or_else(|| partner(in_run)) {
            return Some((ranges[j], *e));
        }
        if e.prefix {
            let mut seen = in_stack;
            seen[e.side as usize].get_or_insert(i);
            stack.push((i, seen));
        } else {
            let mut seen = in_run;
            seen[e.side as usize].get_or_insert(i);
            run = Some((e.s, seen));
        }
    }
    None
}

fn bad_prefix(p: &str) -> bool {
    p.is_empty() || p == "/" || !p.ends_with('/')
}

/// Validates `req` (see the module docs for the rules).
pub fn validate(req: &JobRequest) -> AppResult<()> {
    if req.src_bucket.trim().is_empty() {
        return Err(AppError::invalid("srcBucket is required"));
    }
    if req.items.is_empty() {
        return Err(AppError::invalid("items must not be empty"));
    }
    if req.items.len() > JOB_MAX_ITEMS {
        return Err(AppError::invalid(format!(
            "items: at most {JOB_MAX_ITEMS} per job (got {})",
            req.items.len()
        )));
    }
    let verb = match req.kind {
        JobKind::Delete => "delete",
        JobKind::Copy => "copy",
        JobKind::Move => "move",
        JobKind::Tag => "tag",
    };
    let transfer = matches!(req.kind, JobKind::Copy | JobKind::Move);
    let dest_bucket = match (&req.dest_bucket, transfer) {
        (Some(_), false) => return Err(AppError::invalid(format!("destBucket must be null for {verb}"))),
        (None, true) => return Err(AppError::invalid(format!("destBucket is required for {verb}"))),
        (Some(b), true) if b.trim().is_empty() => {
            return Err(AppError::invalid(format!("destBucket is required for {verb}")))
        }
        (d, _) => d.as_deref(),
    };
    match (&req.tags, req.kind) {
        (None, JobKind::Tag) => return Err(AppError::invalid("tags is required for tag")),
        (Some(op), JobKind::Tag) => crate::tags::validate_operation(op)?,
        (Some(_), _) => return Err(AppError::invalid(format!("tags must be absent for {verb} (it is only used by tag)"))),
        (None, _) => {}
    }
    let same_bucket = dest_bucket == Some(req.src_bucket.as_str());

    for (i, it) in req.items.iter().enumerate() {
        let at = format!("items[{i}]");
        if it.from.is_empty() {
            return Err(AppError::invalid(format!("{at}.from must not be empty")));
        }
        if it.is_prefix && bad_prefix(&it.from) {
            return Err(AppError::invalid(format!(
                "{at}.from must be a folder prefix ending in \"/\" (and not \"/\" alone) when isPrefix is true: {:?}",
                it.from
            )));
        }
        if !transfer {
            if it.to.is_some() {
                return Err(AppError::invalid(format!("{at}.to must be null for {verb}")));
            }
            continue;
        }
        let Some(to) = it.to.as_deref() else {
            return Err(AppError::invalid(format!("{at}.to is required for {verb}")));
        };
        if it.is_prefix {
            if bad_prefix(to) {
                return Err(AppError::invalid(format!(
                    "{at}.to must be a folder prefix ending in \"/\" (and not \"/\" alone) when isPrefix is true: {to:?}"
                )));
            }
        } else if to.is_empty() {
            return Err(AppError::invalid(format!("{at}.to must not be empty")));
        } else if to.ends_with('/') {
            return Err(AppError::invalid(format!("{at}.to: an object destination must not end with \"/\": {to:?}")));
        }
        if same_bucket && to == it.from {
            return Err(AppError::invalid(format!("{at}: the destination is the same as the source ({:?})", it.from)));
        }
        if same_bucket && it.is_prefix && to.starts_with(&it.from) {
            return Err(AppError::invalid(format!(
                "{at}: cannot {verb} the folder {:?} into itself or one of its subfolders ({to:?})",
                it.from
            )));
        }
    }
    if !transfer {
        return Ok(());
    }

    let dests: Vec<Range> = req
        .items
        .iter()
        .enumerate()
        .filter_map(|(i, it)| it.to.as_deref().map(|to| Range { s: to, prefix: it.is_prefix, side: Side::Dest, item: i }))
        .collect();
    if let Some((a, b)) = find_overlap(dests.clone(), false) {
        let (first, second) = if a.item <= b.item { (a, b) } else { (b, a) };
        return Err(AppError::invalid(if a.s == b.s {
            format!("items[{}] and items[{}] would both write to {:?}", first.item, second.item, a.s)
        } else {
            format!(
                "items[{}] and items[{}] would write into the same destination: {:?} is inside {:?}",
                first.item, second.item, b.s, a.s
            )
        }));
    }
    if same_bucket {
        let mut all = dests;
        all.extend(
            req.items
                .iter()
                .enumerate()
                .map(|(i, it)| Range { s: &it.from, prefix: it.is_prefix, side: Side::Src, item: i }),
        );
        if let Some((a, b)) = find_overlap(all, true) {
            let (src, dest) = if a.side == Side::Src { (a, b) } else { (b, a) };
            return Err(AppError::invalid(format!(
                "items[{}] would write to {:?}, which overlaps the source {:?} of items[{}]. A job cannot write into its own sources.",
                dest.item, dest.s, src.s, src.item
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::models::{ConflictPolicy, JobItem};

    fn obj(from: &str, to: Option<&str>) -> JobItem {
        JobItem { from: from.into(), to: to.map(Into::into), is_prefix: false }
    }
    fn pre(from: &str, to: Option<&str>) -> JobItem {
        JobItem { from: from.into(), to: to.map(Into::into), is_prefix: true }
    }
    fn req(kind: JobKind, dest: Option<&str>, items: Vec<JobItem>) -> JobRequest {
        JobRequest {
            kind,
            src_bucket: "b".into(),
            dest_bucket: dest.map(Into::into),
            items,
            on_conflict: ConflictPolicy::Skip,
            tags: None,
        }
    }
    fn ok(r: &JobRequest) {
        if let Err(e) = validate(r) {
            panic!("expected valid, got {e:?} for {r:?}");
        }
    }
    fn bad(r: &JobRequest, needle: &str) {
        match validate(r) {
            Ok(()) => panic!("expected InvalidInput containing {needle:?} for {r:?}"),
            Err(e) => {
                assert_eq!(e.code, ErrorCode::InvalidInput);
                assert!(e.message.contains(needle), "{:?} does not contain {needle:?}", e.message);
            }
        }
    }
    fn copy(items: Vec<JobItem>) -> JobRequest {
        req(JobKind::Copy, Some("b"), items)
    }
    fn mv(items: Vec<JobItem>) -> JobRequest {
        req(JobKind::Move, Some("b"), items)
    }

    fn tag_op(mode: crate::models::TagMode, set: &[(&str, &str)], remove: &[&str]) -> crate::models::TagOperation {
        crate::models::TagOperation {
            mode,
            set: set.iter().map(|(k, v)| crate::models::Tag::new(*k, *v)).collect(),
            remove: remove.iter().map(|s| s.to_string()).collect(),
        }
    }
    fn tag(items: Vec<JobItem>, op: Option<crate::models::TagOperation>) -> JobRequest {
        JobRequest { tags: op, ..req(JobKind::Tag, None, items) }
    }

    #[test]
    fn tag_kind() {
        use crate::models::TagMode::{Merge, Replace};
        let merge = || Some(tag_op(Merge, &[("env", "prod")], &["old"]));
        ok(&tag(vec![obj("a.txt", None), pre("logs/", None)], merge()));
        ok(&tag(vec![obj("a.txt", None)], Some(tag_op(Replace, &[], &[]))));
        // tags required for tag, rejected for every other kind
        bad(&tag(vec![obj("a", None)], None), "tags is required for tag");
        for (kind, dest) in [(JobKind::Delete, None), (JobKind::Copy, Some("b")), (JobKind::Move, Some("b"))] {
            let mut r = req(kind, dest, vec![obj("a", if dest.is_some() { Some("z") } else { None })]);
            ok(&r);
            r.tags = merge();
            bad(&r, "tags must be absent");
        }
        // destBucket must be null; `to` must be null on every item
        let mut r = tag(vec![obj("a", None)], merge());
        r.dest_bucket = Some("b".into());
        bad(&r, "destBucket must be null for tag");
        bad(&tag(vec![obj("a", None), obj("b", Some("c"))], merge()), "items[1].to must be null for tag");
        bad(&tag(vec![pre("p/", Some("q/"))], merge()), "items[0].to must be null for tag");
        // the usual item rules still apply
        bad(&tag(vec![], merge()), "must not be empty");
        bad(&tag(vec![pre("/", None)], merge()), "folder prefix");
        bad(&tag(vec![obj("", None)], merge()), "must not be empty");
        // the operation itself is validated with the object limit
        let eleven: Vec<(String, String)> = (0..11).map(|i| (format!("k{i}"), "v".to_string())).collect();
        let eleven: Vec<(&str, &str)> = eleven.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        bad(&tag(vec![obj("a", None)], Some(tag_op(Replace, &eleven, &[]))), "At most 10");
        bad(&tag(vec![obj("a", None)], Some(tag_op(Merge, &[("aws:x", "1")], &[]))), "reserved");
        bad(&tag(vec![obj("a", None)], Some(tag_op(Merge, &[("a*", "1")], &[]))), "aren't allowed");
        bad(&tag(vec![obj("a", None)], Some(tag_op(Merge, &[("k", "1"), ("k", "2")], &[]))), "more than once");
        bad(&tag(vec![obj("a", None)], Some(tag_op(Replace, &[], &["x"]))), "only used with mode");
        bad(&tag(vec![obj("a", None)], Some(tag_op(Merge, &[], &[]))), "nothing to add");
        // overlapping or duplicate items are fine for tag (de-duplicated at expansion)
        ok(&tag(vec![pre("p/", None), pre("p/q/", None), obj("p/x", None), obj("p/x", None)], merge()));
    }

    #[test]
    fn tag_request_json() {
        let r: JobRequest = serde_json::from_value(serde_json::json!({
            "kind": "tag", "srcBucket": "b", "destBucket": null,
            "items": [{"from": "a", "to": null, "isPrefix": false}],
            "onConflict": "skip",
            "tags": {"mode": "replace", "set": [{"key": "k", "value": "v"}], "remove": []}
        }))
        .expect("parse");
        assert_eq!(r.kind, JobKind::Tag);
        ok(&r);
        // a v0.3 request without `tags` still parses
        let r: JobRequest = serde_json::from_value(serde_json::json!({
            "kind": "delete", "srcBucket": "b", "destBucket": null,
            "items": [{"from": "a", "to": null, "isPrefix": false}], "onConflict": "skip"
        }))
        .expect("parse");
        assert!(r.tags.is_none());
        ok(&r);
    }

    #[test]
    fn basic_shape() {
        ok(&req(JobKind::Delete, None, vec![obj("a", None)]));
        bad(&req(JobKind::Delete, None, vec![]), "must not be empty");
        let mut r = req(JobKind::Delete, None, vec![obj("a", None)]);
        r.src_bucket = String::new();
        bad(&r, "srcBucket");
        r.src_bucket = "  ".into();
        bad(&r, "srcBucket");
        // 10,000 is fine, 10,001 is not.
        let many: Vec<JobItem> = (0..JOB_MAX_ITEMS).map(|i| obj(&format!("k{i}"), None)).collect();
        ok(&req(JobKind::Delete, None, many.clone()));
        let mut more = many;
        more.push(obj("x", None));
        bad(&req(JobKind::Delete, None, more), "at most 10000");
    }

    #[test]
    fn delete_rules() {
        bad(&req(JobKind::Delete, Some("b"), vec![obj("a", None)]), "destBucket must be null");
        bad(&req(JobKind::Delete, None, vec![obj("a", Some("x"))]), "to must be null");
        bad(&req(JobKind::Delete, None, vec![obj("", None)]), "from must not be empty");
        bad(&req(JobKind::Delete, None, vec![pre("a", None)]), "ending in");
        bad(&req(JobKind::Delete, None, vec![pre("", None)]), "must not be empty");
        bad(&req(JobKind::Delete, None, vec![pre("/", None)]), "ending in");
        // Odd but legal prefixes pass through untouched.
        for p in ["a//", "/a/", "a/../b/", " a /", "a b/ü/", "%2F/", "a+b/", "trailing./", "//"] {
            ok(&req(JobKind::Delete, None, vec![pre(p, None)]));
        }
        // Overlapping and duplicate delete items are allowed (de-duplicated when expanded).
        ok(&req(JobKind::Delete, None, vec![pre("a/", None), pre("a/b/", None), obj("a/b/c", None), obj("a/b/c", None)]));
        // An object item may name a key ending in "/" (a folder marker on its own).
        ok(&req(JobKind::Delete, None, vec![obj("a/", None)]));
    }

    #[test]
    fn copy_move_shape() {
        for kind in [JobKind::Copy, JobKind::Move] {
            bad(&req(kind, None, vec![obj("a", Some("b"))]), "destBucket is required");
            bad(&req(kind, Some(" "), vec![obj("a", Some("b"))]), "destBucket is required");
            bad(&req(kind, Some("b"), vec![obj("a", None)]), "to is required");
            bad(&req(kind, Some("b"), vec![obj("a", Some(""))]), "must not be empty");
            bad(&req(kind, Some("b"), vec![obj("a", Some("x/"))]), "must not end with");
            bad(&req(kind, Some("b"), vec![pre("a/", Some("x"))]), "ending in");
            bad(&req(kind, Some("b"), vec![pre("a/", Some(""))]), "ending in");
            bad(&req(kind, Some("b"), vec![pre("a/", Some("/"))]), "ending in");
            bad(&req(kind, Some("other"), vec![pre("a/", Some("/"))]), "ending in");
            ok(&req(kind, Some("b"), vec![obj("a", Some("b"))]));
            ok(&req(kind, Some("b"), vec![pre("a/", Some("x/"))]));
        }
    }

    #[test]
    fn same_source_and_destination() {
        bad(&copy(vec![obj("a", Some("a"))]), "same as the source");
        bad(&mv(vec![pre("a/", Some("a/"))]), "same as the source");
        // Different bucket: same key is a plain copy.
        ok(&req(JobKind::Move, Some("other"), vec![obj("a", Some("a"))]));
        ok(&req(JobKind::Copy, Some("other"), vec![pre("a/", Some("a/"))]));
        // Byte-for-byte: no case folding, no trimming, no normalization.
        ok(&mv(vec![obj("a", Some("A"))]));
        ok(&mv(vec![obj("a", Some("a "))]));
        ok(&mv(vec![obj("a/b", Some("a//b"))]));
        ok(&mv(vec![obj("a/../b", Some("b"))]));
        ok(&mv(vec![obj("a%2Fb", Some("a/b"))]));
        ok(&mv(vec![obj("a+b", Some("a b"))]));
        ok(&mv(vec![obj("a.", Some("a"))]));
        // "a//" is a different folder from "a/", but "a/" contains it: a source/destination overlap.
        bad(&mv(vec![pre("a//", Some("a/"))]), "own sources");
        ok(&req(JobKind::Move, Some("other"), vec![pre("a//", Some("a/"))]));
    }

    #[test]
    fn into_itself_or_descendant() {
        bad(&copy(vec![pre("a/", Some("a/b/"))]), "into itself");
        bad(&mv(vec![pre("a/", Some("a/a/"))]), "into itself");
        bad(&mv(vec![pre("a/", Some("a//"))]), "into itself");
        // String prefix but not the same folder: "foo/" vs "foobar/".
        ok(&mv(vec![pre("foo/", Some("foobar/"))]));
        ok(&mv(vec![pre("foobar/", Some("foo/x/"))]));
        // Other bucket: fine.
        ok(&req(JobKind::Move, Some("other"), vec![pre("a/", Some("a/b/"))]));
    }

    #[test]
    fn destination_overlaps() {
        bad(&copy(vec![obj("a", Some("x")), obj("b", Some("x"))]), "both write to \"x\"");
        bad(&copy(vec![pre("a/", Some("x/")), pre("b/", Some("x/"))]), "both write to");
        bad(&copy(vec![pre("a/", Some("x/")), obj("b", Some("x/b"))]), "same destination");
        bad(&copy(vec![obj("b", Some("x/y/b")), pre("a/", Some("x/"))]), "same destination");
        bad(&copy(vec![pre("a/", Some("x/")), pre("b/", Some("x/y/"))]), "same destination");
        // Cross bucket, the destination rules still apply (all destinations share one bucket).
        bad(&req(JobKind::Copy, Some("o"), vec![obj("a", Some("x")), obj("b", Some("x"))]), "both write");
        // "x" object and "x/" prefix never share a key; "foo/" and "foobar/" neither.
        ok(&copy(vec![obj("a", Some("x")), pre("b/", Some("x/"))]));
        ok(&copy(vec![pre("a/", Some("foo/")), pre("b/", Some("foobar/"))]));
        // Case and whitespace make different keys.
        ok(&copy(vec![obj("a", Some("X")), obj("b", Some("x")), obj("c", Some("x "))]));
        // An object destination equal to another object item's source in another bucket is fine.
        ok(&req(JobKind::Copy, Some("o"), vec![obj("a", Some("b")), obj("b", Some("c"))]));
    }

    #[test]
    fn destination_overlaps_a_source_in_same_bucket() {
        // Folder moved into its parent's sibling position that contains it: "a/b/" -> "a/".
        bad(&mv(vec![pre("a/b/", Some("a/"))]), "own sources");
        // Rotation: x/ -> y/ while y/ -> z/.
        bad(&mv(vec![pre("x/", Some("y/")), pre("y/", Some("z/"))]), "own sources");
        bad(&copy(vec![obj("a", Some("b")), obj("b", Some("c"))]), "own sources");
        // Writing an object into a folder that is being moved.
        bad(&mv(vec![pre("f/", Some("g/")), obj("k", Some("f/k"))]), "own sources");
        // Writing a folder over an object that is moved.
        bad(&mv(vec![obj("x/a", Some("y")), pre("b/", Some("x/"))]), "own sources");
        // Swaps are rejected too.
        bad(&mv(vec![obj("a", Some("b")), obj("b", Some("a"))]), "own sources");
        // Different bucket: no interaction between sources and destinations.
        ok(&req(JobKind::Move, Some("o"), vec![pre("x/", Some("y/")), pre("y/", Some("z/"))]));
        // Siblings with a shared string prefix do not overlap.
        ok(&mv(vec![pre("foo/", Some("foobar2/")), obj("foo", Some("foo2"))]));
        ok(&mv(vec![obj("foo", Some("bar/foo")), pre("foo/", Some("bar/foo/"))]));
        // A typical paste of several items into another folder.
        ok(&mv(vec![pre("p/a/", Some("q/a/")), obj("p/b.txt", Some("q/b.txt")), pre("p/c/", Some("q/c/"))]));
        // A typical rename.
        ok(&mv(vec![pre("p/old/", Some("p/new/"))]));
        ok(&mv(vec![obj("p/old.txt", Some("p/new.txt"))]));
    }

    #[test]
    fn overlap_engine() {
        let r = |s: &'static str, prefix: bool, side: Side, item: usize| Range { s, prefix, side, item };
        use Side::{Dest as D, Src as S};
        assert!(find_overlap(vec![r("a/", true, S, 0), r("a/b", false, S, 1)], true).is_none());
        assert!(find_overlap(vec![r("a/", true, S, 0), r("a/b", false, S, 1)], false).is_some());
        assert!(find_overlap(vec![r("a/", true, S, 0), r("a/b", false, D, 1)], true).is_some());
        assert!(find_overlap(vec![r("a/b", false, D, 0), r("a/", true, S, 1)], true).is_some());
        assert!(find_overlap(vec![r("a", false, D, 0), r("a/", true, S, 1)], true).is_none());
        assert!(find_overlap(vec![r("a/", false, D, 0), r("a/", true, S, 1)], true).is_some());
        assert!(find_overlap(vec![r("a/", true, D, 0), r("a/", false, S, 1)], true).is_some());
        assert!(find_overlap(vec![r("foo/", true, D, 0), r("foobar/", true, S, 1)], true).is_none());
        assert!(find_overlap(vec![r("foo", false, D, 0), r("foo/", true, S, 1)], true).is_none());
        assert!(find_overlap(vec![r("k", false, D, 0), r("k", false, S, 1)], true).is_some());
        assert!(find_overlap(vec![r("k", false, S, 0), r("k", false, S, 1)], true).is_none());
        // A deep chain where the conflicting ancestor is far up the stack.
        let mut v = vec![r("a/", true, S, 0)];
        let deep: Vec<String> = (1..200).map(|n| format!("a/{}", "x/".repeat(n))).collect();
        let deep: Vec<&'static str> = deep.into_iter().map(|s| &*Box::leak(s.into_boxed_str())).collect();
        for (i, s) in deep.iter().enumerate() {
            v.push(r(s, true, S, i + 1));
        }
        assert!(find_overlap(v.clone(), true).is_none());
        v.push(r("a/x/x/x/y", false, D, 999));
        let (a, b) = find_overlap(v, true).expect("overlap");
        assert_eq!((a.s, a.side, b.s, b.side), ("a/", S, "a/x/x/x/y", D));
        // Popping works: an unrelated later key does not conflict with a closed prefix.
        assert!(find_overlap(vec![r("a/", true, S, 0), r("a/b", false, S, 1), r("b", false, D, 2)], true).is_none());
    }

    #[test]
    fn many_items_is_fast() {
        let items: Vec<JobItem> = (0..JOB_MAX_ITEMS)
            .map(|i| if i % 2 == 0 { pre(&format!("src/{i}/"), Some(&format!("dst/{i}/"))) } else { obj(&format!("src/{i}"), Some(&format!("dst/{i}"))) })
            .collect();
        let t = std::time::Instant::now();
        ok(&mv(items));
        assert!(t.elapsed().as_secs() < 2);
    }
}
