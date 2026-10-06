//! Bucket and object tags: validation (shared by the commands, bulk tag jobs and, later, lifecycle
//! filters), set comparison, merge, and the S3 calls.
//!
//! No Tauri types here. Every write is a full replacement of the tag set (S3 has no partial tag
//! update), guarded by comparing the server's current set with the one the UI loaded.

use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use aws_sdk_s3::config::http::HttpResponse;
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::types::{Tag as S3Tag, Tagging};
use aws_sdk_s3::Client;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{Tag, TagMode, TagOperation};

/// Most tags on one bucket.
pub const BUCKET_MAX_TAGS: usize = 50;
/// Most tags on one object.
pub const OBJECT_MAX_TAGS: usize = 10;
/// Key length in Unicode characters.
pub const KEY_MAX_CHARS: usize = 128;
/// Value length in Unicode characters.
pub const VALUE_MAX_CHARS: usize = 256;
pub const RESERVED_KEY_PREFIX: &str = "aws:";

/// Letters, numbers, space separators (any Unicode `\p{Z}`, as AWS allows) and `+ - = . _ : / @`
/// (the UI uses the same Unicode classes).
static ALLOWED: LazyLock<regex::Regex> = LazyLock::new(|| {
    // A fixed, valid pattern: this cannot fail at run time.
    #[allow(clippy::expect_used)]
    regex::Regex::new(r"^[\p{L}\p{N}\p{Z}+\-=._:/@]*$").expect("static tag pattern")
});

pub const ALLOWED_CHARS_TEXT: &str = "letters, numbers, spaces and + - = . _ : / @";

/// A key as shown in a message: quoted, and shortened when very long.
fn shown(key: &str) -> String {
    const MAX: usize = 40;
    if key.chars().count() > MAX {
        let head: String = key.chars().take(MAX).collect();
        format!("“{head}…”")
    } else {
        format!("“{key}”")
    }
}

/// Checks one tag key (length, reserved prefix, characters). `InvalidInput` naming the key.
pub fn validate_tag_key(key: &str) -> AppResult<()> {
    if key.is_empty() {
        return Err(AppError::invalid("A tag key can't be empty."));
    }
    let n = key.chars().count();
    if n > KEY_MAX_CHARS {
        return Err(AppError::invalid(format!(
            "The tag key {} is {n} characters long; the limit is {KEY_MAX_CHARS}.",
            shown(key)
        )));
    }
    // Case-insensitive: stricter than a plain prefix test, so "AWS:x" is refused here too.
    if key.get(..RESERVED_KEY_PREFIX.len()).is_some_and(|p| p.eq_ignore_ascii_case(RESERVED_KEY_PREFIX)) {
        return Err(AppError::invalid(format!(
            "The tag key {} starts with “aws:”, which is reserved for AWS.",
            shown(key)
        )));
    }
    if !ALLOWED.is_match(key) {
        return Err(AppError::invalid(format!(
            "The tag key {} contains characters that aren't allowed. Use {ALLOWED_CHARS_TEXT}.",
            shown(key)
        )));
    }
    Ok(())
}

/// Validates a whole tag set against the limits in the contract: at most `max` tags; each key
/// 1..=128 and each value 0..=256 Unicode characters; keys unique (case-sensitive); no `aws:`
/// keys; only letters, numbers, spaces and `+ - = . _ : / @`. The first problem is returned as
/// `InvalidInput` naming the offending key.
pub fn validate_tags(tags: &[Tag], max: usize) -> AppResult<()> {
    if tags.len() > max {
        return Err(AppError::invalid(format!("At most {max} tags are allowed here; there are {}.", tags.len())));
    }
    let mut seen: HashSet<&str> = HashSet::with_capacity(tags.len());
    for t in tags {
        validate_tag_key(&t.key)?;
        let n = t.value.chars().count();
        if n > VALUE_MAX_CHARS {
            return Err(AppError::invalid(format!(
                "The value of tag {} is {n} characters long; the limit is {VALUE_MAX_CHARS}.",
                shown(&t.key)
            )));
        }
        if !ALLOWED.is_match(&t.value) {
            return Err(AppError::invalid(format!(
                "The value of tag {} contains characters that aren't allowed. Use {ALLOWED_CHARS_TEXT}.",
                shown(&t.key)
            )));
        }
        if !seen.insert(t.key.as_str()) {
            return Err(AppError::invalid(format!("The tag key {} is used more than once.", shown(&t.key))));
        }
    }
    Ok(())
}

/// Validates a bulk tag operation (the object limit applies to `set`).
pub fn validate_operation(op: &TagOperation) -> AppResult<()> {
    validate_tags(&op.set, OBJECT_MAX_TAGS).map_err(|e| AppError::invalid(format!("tags.set: {}", e.message)))?;
    match op.mode {
        TagMode::Replace => {
            if !op.remove.is_empty() {
                return Err(AppError::invalid("tags.remove is only used with mode \"merge\"."));
            }
        }
        TagMode::Merge => {
            if op.set.is_empty() && op.remove.is_empty() {
                return Err(AppError::invalid("tags: nothing to add, change or remove."));
            }
            let set_keys: HashSet<&str> = op.set.iter().map(|t| t.key.as_str()).collect();
            for k in &op.remove {
                if k.is_empty() {
                    return Err(AppError::invalid("tags.remove: a tag key can't be empty."));
                }
                if k.chars().count() > KEY_MAX_CHARS {
                    return Err(AppError::invalid(format!(
                        "tags.remove: the tag key {} is longer than {KEY_MAX_CHARS} characters.",
                        shown(k)
                    )));
                }
                if set_keys.contains(k.as_str()) {
                    return Err(AppError::invalid(format!(
                        "tags: the key {} is both set and removed.",
                        shown(k)
                    )));
                }
            }
        }
    }
    Ok(())
}

/// True when `a` and `b` hold the same (key, value) pairs, ignoring order (and repeats).
pub fn same_set(a: &[Tag], b: &[Tag]) -> bool {
    let sa: BTreeSet<(&str, &str)> = a.iter().map(|t| (t.key.as_str(), t.value.as_str())).collect();
    let sb: BTreeSet<(&str, &str)> = b.iter().map(|t| (t.key.as_str(), t.value.as_str())).collect();
    sa == sb
}

/// `current` with `remove` keys dropped, then each `set` tag updated in place or appended.
/// Order: existing tags keep their position, new ones follow in `set` order.
pub fn merge(current: &[Tag], set: &[Tag], remove: &[String]) -> Vec<Tag> {
    let removed: HashSet<&str> = remove.iter().map(String::as_str).collect();
    let mut out: Vec<Tag> = current.iter().filter(|t| !removed.contains(t.key.as_str())).cloned().collect();
    for t in set {
        match out.iter_mut().find(|o| o.key == t.key) {
            Some(o) => o.value = t.value.clone(),
            None => out.push(t.clone()),
        }
    }
    out
}

/// The tag set an operation produces for an object whose tags are `current`.
pub fn apply(op: &TagOperation, current: &[Tag]) -> Vec<Tag> {
    match op.mode {
        TagMode::Replace => op.set.clone(),
        TagMode::Merge => merge(current, &op.set, &op.remove),
    }
}

/// Per-object failure of a merge whose result is over the object limit.
pub fn over_limit_message(n: usize) -> String {
    format!("The object would have {n} tags; the limit is {OBJECT_MAX_TAGS}. It was left unchanged.")
}

fn to_sdk(tags: &[Tag]) -> AppResult<Tagging> {
    let set = tags
        .iter()
        .map(|t| S3Tag::builder().key(&t.key).value(&t.value).build())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::invalid(format!("Invalid tag: {e}")))?;
    Tagging::builder().set_tag_set(Some(set)).build().map_err(|e| AppError::invalid(format!("Invalid tags: {e}")))
}

fn from_sdk(set: &[S3Tag]) -> Vec<Tag> {
    set.iter().map(|t| Tag::new(t.key(), t.value())).collect()
}

/// Per-object failure when an object-level tagging call answers HTTP 405: the object's current
/// version is a delete marker (not a missing feature).
pub const DELETE_MARKER: &str = "The object was deleted (its current version is a delete marker).";

/// An object-level tagging error: 405 / `MethodNotAllowed` is a delete marker (`NoSuchKey`);
/// NotImplemented / 501 stays `NotSupported`.
fn object_err<E>(e: SdkError<E, HttpResponse>) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
{
    let status = e.raw_response().map(|r| r.status().as_u16());
    let method_not_allowed = e.as_service_error().and_then(|s| s.code()) == Some("MethodNotAllowed");
    if status == Some(405) || method_not_allowed {
        return AppError::new(ErrorCode::NoSuchKey, DELETE_MARKER);
    }
    feature(e.into(), "object tags")
}

/// AWS system tags (`aws:...`, e.g. from CloudFormation): shown, passed through, never written changed.
pub fn is_system_tag(key: &str) -> bool {
    key.get(..RESERVED_KEY_PREFIX.len()).is_some_and(|p| p.eq_ignore_ascii_case(RESERVED_KEY_PREFIX))
}

/// The tag set to write for `tags`, given the set the UI loaded (`expected`). An `aws:` tag is
/// accepted only when the same key and value are in `expected`; every system tag in `expected` is
/// kept (they can't be removed here either); the other tags are validated normally. At most `max`
/// in total.
pub fn with_system_tags(tags: &[Tag], expected: &[Tag], max: usize) -> AppResult<Vec<Tag>> {
    let system: Vec<Tag> = expected.iter().filter(|t| is_system_tag(&t.key)).cloned().collect();
    for t in tags.iter().filter(|t| is_system_tag(&t.key)) {
        if !system.iter().any(|s| s.key == t.key && s.value == t.value) {
            return Err(AppError::invalid(format!(
                "The tag {} is an AWS system tag (its key starts with “aws:”); it can't be added or changed here.",
                shown(&t.key)
            )));
        }
    }
    let user: Vec<Tag> = tags.iter().filter(|t| !is_system_tag(&t.key)).cloned().collect();
    validate_tags(&user, max)?;
    let total = system.len() + user.len();
    if total > max {
        return Err(AppError::invalid(format!(
            "At most {max} tags are allowed here; there are {total}, including {} AWS system tags.",
            system.len()
        )));
    }
    Ok(system.into_iter().chain(user).collect())
}

/// Rewrites a `NotSupported` error with a plain sentence naming the feature.
fn feature(e: AppError, what: &str) -> AppError {
    if e.code == ErrorCode::NotSupported {
        AppError::new(ErrorCode::NotSupported, format!("This server does not support {what} ({}).", e.message))
    } else {
        e
    }
}

pub const BUCKET_CONFLICT: &str =
    "The bucket's tags were changed by someone else since they were loaded. Nothing was saved. Reload to see the current tags.";
pub const OBJECT_CONFLICT: &str =
    "The object's tags were changed by someone else since they were loaded. Nothing was saved. Reload to see the current tags.";

/// `GetBucketTagging`; `[]` when the bucket has no tag set.
pub async fn get_bucket_tags(client: &Client, bucket: &str) -> AppResult<Vec<Tag>> {
    match client.get_bucket_tagging().bucket(bucket).send().await {
        Ok(out) => Ok(from_sdk(out.tag_set())),
        Err(e) => {
            let code = e.as_service_error().and_then(aws_sdk_s3::error::ProvideErrorMetadata::code);
            if matches!(code, Some("NoSuchTagSet") | Some("NoSuchTagSetError")) {
                Ok(Vec::new())
            } else {
                Err(feature(AppError::from(e), "bucket tags"))
            }
        }
    }
}

/// Replaces the bucket's tag set with `tags` (empty: `DeleteBucketTagging`) if the current set
/// equals `expected` (as a set), then returns what is stored. Mismatch: `Conflict`, nothing written.
/// AWS system tags in `expected` are passed through (see [`with_system_tags`]), so the tagging is
/// never deleted while the bucket has one.
pub async fn put_bucket_tags(client: &Client, bucket: &str, tags: &[Tag], expected: &[Tag]) -> AppResult<Vec<Tag>> {
    let tags = &with_system_tags(tags, expected, BUCKET_MAX_TAGS)?;
    let current = get_bucket_tags(client, bucket).await?;
    if !same_set(&current, expected) {
        return Err(AppError::new(ErrorCode::Conflict, BUCKET_CONFLICT));
    }
    if tags.is_empty() {
        client.delete_bucket_tagging().bucket(bucket).send().await.map_err(|e| feature(e.into(), "bucket tags"))?;
    } else {
        client
            .put_bucket_tagging()
            .bucket(bucket)
            .tagging(to_sdk(tags)?)
            .send()
            .await
            .map_err(|e| feature(e.into(), "bucket tags"))?;
    }
    get_bucket_tags(client, bucket).await.map_err(AppError::saved_but_unread)
}

/// `GetObjectTagging` (an object without tags has an empty set).
pub async fn get_object_tags(client: &Client, bucket: &str, key: &str) -> AppResult<Vec<Tag>> {
    let out = client
        .get_object_tagging()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(object_err)?;
    Ok(from_sdk(out.tag_set()))
}

/// Writes `tags` as the object's complete tag set (`DeleteObjectTagging` when empty).
async fn write_object_tags(client: &Client, bucket: &str, key: &str, tags: &[Tag]) -> AppResult<()> {
    if tags.is_empty() {
        client
            .delete_object_tagging()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(object_err)?;
    } else {
        client
            .put_object_tagging()
            .bucket(bucket)
            .key(key)
            .tagging(to_sdk(tags)?)
            .send()
            .await
            .map_err(object_err)?;
    }
    Ok(())
}

/// Replaces one object's tag set (see [`put_bucket_tags`] for the `expected` rule).
pub async fn put_object_tags(
    client: &Client,
    bucket: &str,
    key: &str,
    tags: &[Tag],
    expected: &[Tag],
) -> AppResult<Vec<Tag>> {
    if key.is_empty() {
        return Err(AppError::invalid("An object key is required"));
    }
    let tags = &with_system_tags(tags, expected, OBJECT_MAX_TAGS)?;
    let current = get_object_tags(client, bucket, key).await?;
    if !same_set(&current, expected) {
        return Err(AppError::new(ErrorCode::Conflict, OBJECT_CONFLICT));
    }
    write_object_tags(client, bucket, key, tags).await?;
    get_object_tags(client, bucket, key).await.map_err(AppError::saved_but_unread)
}

pub const OBJECT_GONE: &str = "NoSuchKey: The object no longer exists.";

/// One object of a bulk tag job. `Err` carries the per-object message and the error code.
pub async fn tag_object(client: &Client, bucket: &str, key: &str, op: &TagOperation) -> Result<(), AppError> {
    let gone = |e: AppError| {
        if e.code == ErrorCode::NoSuchKey && e.message != DELETE_MARKER {
            AppError::new(ErrorCode::NoSuchKey, OBJECT_GONE)
        } else {
            e
        }
    };
    let next = match op.mode {
        TagMode::Replace => op.set.clone(),
        TagMode::Merge => {
            let current = get_object_tags(client, bucket, key).await.map_err(gone)?;
            let next = apply(op, &current);
            if next.len() > OBJECT_MAX_TAGS {
                return Err(AppError::invalid(over_limit_message(next.len())));
            }
            if same_set(&current, &next) {
                return Ok(()); // already as requested: nothing to write
            }
            next
        }
    };
    write_object_tags(client, bucket, key, &next).await.map_err(gone)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(k: &str, v: &str) -> Tag {
        Tag::new(k, v)
    }

    fn msg(r: AppResult<()>) -> String {
        let e = r.expect_err("should be rejected");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        e.message
    }

    #[test]
    fn count_limits() {
        let ten: Vec<Tag> = (0..10).map(|i| t(&format!("k{i}"), "v")).collect();
        assert!(validate_tags(&ten, OBJECT_MAX_TAGS).is_ok());
        let mut eleven = ten.clone();
        eleven.push(t("k10", "v"));
        assert!(msg(validate_tags(&eleven, OBJECT_MAX_TAGS)).contains("At most 10"));
        assert!(validate_tags(&eleven, BUCKET_MAX_TAGS).is_ok());
        let fifty: Vec<Tag> = (0..50).map(|i| t(&format!("k{i}"), "v")).collect();
        assert!(validate_tags(&fifty, BUCKET_MAX_TAGS).is_ok());
        let fifty_one: Vec<Tag> = (0..51).map(|i| t(&format!("k{i}"), "v")).collect();
        assert!(msg(validate_tags(&fifty_one, BUCKET_MAX_TAGS)).contains("At most 50"));
        assert!(validate_tags(&[], OBJECT_MAX_TAGS).is_ok());
    }

    #[test]
    fn lengths_are_counted_in_characters_not_bytes() {
        // 128 three-byte characters = 384 bytes: still valid.
        let key: String = "ж".repeat(128);
        assert!(validate_tags(&[t(&key, "")], 10).is_ok());
        let long_key: String = "ж".repeat(129);
        let m = msg(validate_tags(&[t(&long_key, "")], 10));
        assert!(m.contains("129 characters") && m.contains("limit is 128"), "{m}");
        let value: String = "é".repeat(256);
        assert!(validate_tags(&[t("k", &value)], 10).is_ok());
        let long_value: String = "é".repeat(257);
        let m = msg(validate_tags(&[t("named", &long_value)], 10));
        assert!(m.contains("“named”") && m.contains("limit is 256"), "{m}");
        // 4-byte characters (astral plane letters) count as one each.
        let astral: String = "𝒜".repeat(128);
        assert!(validate_tags(&[t(&astral, "v")], 10).is_ok());
    }

    #[test]
    fn empty_key_and_empty_value() {
        assert!(msg(validate_tags(&[t("", "v")], 10)).contains("can't be empty"));
        assert!(validate_tags(&[t("k", "")], 10).is_ok());
    }

    #[test]
    fn keys_unique_case_sensitive() {
        let m = msg(validate_tags(&[t("Env", "a"), t("x", "b"), t("Env", "c")], 10));
        assert!(m.contains("“Env”") && m.contains("more than once"), "{m}");
        assert!(validate_tags(&[t("env", "a"), t("Env", "b"), t("ENV", "c")], 10).is_ok());
    }

    #[test]
    fn reserved_prefix() {
        for k in ["aws:x", "aws:", "AWS:cloudformation", "Aws:y"] {
            let m = msg(validate_tags(&[t(k, "v")], 10));
            assert!(m.contains("reserved"), "{k}: {m}");
        }
        assert!(validate_tags(&[t("aws", "v"), t("myaws:x", "v"), t("aw:s", "v")], 10).is_ok());
    }

    #[test]
    fn allowed_characters() {
        assert!(validate_tags(&[t("Team Name+1=2._:/@", "a b+c-d=e.f_g:h/i@j")], 10).is_ok());
        assert!(validate_tags(&[t("ключ", "значение"), t("日本", "東京"), t("café", "٣")], 10).is_ok());
        for bad in ["a*b", "a#", "a,b", "tab\there", "new\nline", "q?", "a&b", "😀", "a\\b", "a'b", "a\"b", "a%"] {
            let m = msg(validate_tags(&[t(bad, "v")], 10));
            assert!(m.contains("aren't allowed"), "{bad:?}: {m}");
            let m = msg(validate_tags(&[t("ok", bad)], 10));
            assert!(m.contains("value of tag “ok”"), "{bad:?}: {m}");
        }
    }

    #[test]
    fn unicode_space_separators_are_allowed() {
        // non-breaking space, ideographic space, thin space: all \p{Z}
        for k in ["a\u{00A0}b", "a\u{3000}b", "a\u{2009}b"] {
            assert!(validate_tags(&[t(k, k)], 10).is_ok(), "{k:?}");
        }
        assert!(msg(validate_tags(&[t("a\tb", "v")], 10)).contains("aren't allowed"));
        assert!(msg(validate_tags(&[t("ok", "a\nb")], 10)).contains("aren't allowed"));
    }

    #[test]
    fn long_keys_are_shortened_in_messages() {
        let key = "x".repeat(200);
        let m = msg(validate_tags(&[t(&key, "")], 10));
        assert!(m.contains('…') && m.len() < 200, "{m}");
    }

    #[test]
    fn set_comparison_ignores_order() {
        assert!(same_set(&[t("a", "1"), t("b", "2")], &[t("b", "2"), t("a", "1")]));
        assert!(same_set(&[], &[]));
        assert!(!same_set(&[t("a", "1")], &[t("a", "2")]));
        assert!(!same_set(&[t("a", "1")], &[t("A", "1")]));
        assert!(!same_set(&[t("a", "1")], &[t("a", "1"), t("b", "")]));
        assert!(!same_set(&[t("a", "1")], &[]));
    }

    #[test]
    fn merge_computation() {
        let cur = vec![t("a", "1"), t("b", "2"), t("c", "3")];
        // update in place, append new, remove
        let got = merge(&cur, &[t("b", "20"), t("d", "4")], &["a".to_string(), "zz".to_string()]);
        assert_eq!(got, vec![t("b", "20"), t("c", "3"), t("d", "4")]);
        // nothing to do
        assert_eq!(merge(&cur, &[], &[]), cur);
        // remove everything
        assert!(merge(&cur, &[], &["a".into(), "b".into(), "c".into()]).is_empty());
        // keys are case-sensitive
        assert_eq!(merge(&[t("Env", "x")], &[t("env", "y")], &[]), vec![t("Env", "x"), t("env", "y")]);
        // replace ignores the current set
        let op = TagOperation { mode: TagMode::Replace, set: vec![t("z", "1")], remove: vec![] };
        assert_eq!(apply(&op, &cur), vec![t("z", "1")]);
        let op = TagOperation { mode: TagMode::Replace, set: vec![], remove: vec![] };
        assert!(apply(&op, &cur).is_empty());
        // a merge can exceed the object limit; the caller refuses it
        let nine: Vec<Tag> = (0..9).map(|i| t(&format!("k{i}"), "v")).collect();
        let op = TagOperation { mode: TagMode::Merge, set: vec![t("n1", ""), t("n2", "")], remove: vec![] };
        assert_eq!(apply(&op, &nine).len(), 11);
        assert!(over_limit_message(11).contains("would have 11 tags; the limit is 10"));
    }

    #[test]
    fn operation_validation() {
        let op = |mode, set: Vec<Tag>, remove: Vec<&str>| TagOperation {
            mode,
            set,
            remove: remove.into_iter().map(String::from).collect(),
        };
        assert!(validate_operation(&op(TagMode::Merge, vec![t("a", "1")], vec!["b"])).is_ok());
        assert!(validate_operation(&op(TagMode::Merge, vec![], vec!["b"])).is_ok());
        assert!(validate_operation(&op(TagMode::Replace, vec![], vec![])).is_ok());
        assert!(msg(validate_operation(&op(TagMode::Merge, vec![], vec![]))).contains("nothing"));
        assert!(msg(validate_operation(&op(TagMode::Replace, vec![], vec!["a"]))).contains("only used with mode"));
        assert!(msg(validate_operation(&op(TagMode::Merge, vec![t("a", "1")], vec!["a"]))).contains("both set and removed"));
        assert!(msg(validate_operation(&op(TagMode::Merge, vec![], vec![""]))).contains("can't be empty"));
        let eleven: Vec<Tag> = (0..11).map(|i| t(&format!("k{i}"), "v")).collect();
        assert!(msg(validate_operation(&op(TagMode::Replace, eleven, vec![]))).starts_with("tags.set: At most 10"));
        assert!(msg(validate_operation(&op(TagMode::Merge, vec![t("aws:x", "1")], vec![]))).contains("reserved"));
    }

    #[test]
    fn tag_json_shape() {
        let v = serde_json::to_value(TagOperation { mode: TagMode::Merge, set: vec![t("k", "v")], remove: vec!["r".into()] })
            .expect("json");
        assert_eq!(v, serde_json::json!({"mode": "merge", "set": [{"key": "k", "value": "v"}], "remove": ["r"]}));
    }
}

/// Against a scripted fake S3: system-tag pass-through, read-back failures, delete markers.
#[cfg(test)]
mod server_tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::testutil::{FakeS3, Reply, Req};

    const STACK: &str = "aws:cloudformation:stack-name";

    fn tagging(tags: &[(&str, &str)]) -> String {
        let t: String = tags.iter().map(|(k, v)| format!("<Tag><Key>{k}</Key><Value>{v}</Value></Tag>")).collect();
        format!(r#"<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet>{t}</TagSet></Tagging>"#)
    }

    fn put_body(s3: &FakeS3) -> Option<String> {
        s3.requests().into_iter().find(|r| r.method == "PUT").map(|r| String::from_utf8_lossy(&r.body).to_string())
    }

    fn is_tagging(r: &Req, m: &str) -> bool {
        r.method == m && r.has_query("tagging")
    }

    /// A bucket holding a CloudFormation system tag and one user tag.
    async fn stack_bucket() -> FakeS3 {
        FakeS3::start(|r| match r.method.as_str() {
            "GET" => Reply::xml(200, &tagging(&[(STACK, "prod-stack"), ("env", "prod")])),
            "PUT" => Reply::status(204),
            "DELETE" => Reply::status(204),
            _ => Reply::status(500),
        })
        .await
    }

    fn loaded() -> Vec<Tag> {
        vec![Tag::new(STACK, "prod-stack"), Tag::new("env", "prod")]
    }

    #[tokio::test]
    async fn get_returns_system_tags() {
        let s3 = stack_bucket().await;
        assert_eq!(get_bucket_tags(&s3.client(), "b").await.expect("get"), loaded());
    }

    #[tokio::test]
    async fn editing_a_user_tag_passes_the_system_tag_through() {
        let s3 = stack_bucket().await;
        let next = vec![Tag::new(STACK, "prod-stack"), Tag::new("env", "dev")];
        put_bucket_tags(&s3.client(), "b", &next, &loaded()).await.expect("put");
        let body = put_body(&s3).expect("a PUT was sent");
        assert!(body.contains(&format!("<Key>{STACK}</Key><Value>prod-stack</Value>")), "{body}");
        assert!(body.contains("<Key>env</Key><Value>dev</Value>"), "{body}");
        // The UI may also leave the read-only system tag out: it is still kept.
        let s3 = stack_bucket().await;
        put_bucket_tags(&s3.client(), "b", &[Tag::new("env", "dev")], &loaded()).await.expect("put");
        assert!(put_body(&s3).expect("PUT").contains(STACK));
    }

    #[tokio::test]
    async fn removing_every_user_tag_writes_only_the_system_tag() {
        let s3 = stack_bucket().await;
        put_bucket_tags(&s3.client(), "b", &[], &loaded()).await.expect("put");
        assert_eq!(s3.count(|r| is_tagging(r, "DELETE")), 0, "never DeleteBucketTagging while a system tag exists");
        let body = put_body(&s3).expect("a PUT was sent");
        assert!(body.contains(STACK) && !body.contains("<Key>env</Key>"), "{body}");
    }

    #[tokio::test]
    async fn new_or_changed_system_tags_are_rejected() {
        let s3 = stack_bucket().await;
        for bad in [
            vec![Tag::new(STACK, "prod-stack"), Tag::new("aws:new", "x"), Tag::new("env", "prod")],
            vec![Tag::new(STACK, "other-stack"), Tag::new("env", "prod")],
        ] {
            let e = put_bucket_tags(&s3.client(), "b", &bad, &loaded()).await.expect_err("rejected");
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.contains("AWS system tag"), "{}", e.message);
        }
        assert_eq!(s3.count(|r| r.method == "PUT" || r.method == "DELETE"), 0, "nothing written");
        // Without a system tag in expected, an empty set still deletes the tagging.
        let plain = FakeS3::start(|r| match r.method.as_str() {
            "GET" => Reply::xml(200, &tagging(&[("env", "prod")])),
            _ => Reply::status(204),
        })
        .await;
        put_bucket_tags(&plain.client(), "b", &[], &[Tag::new("env", "prod")]).await.expect("put");
        assert_eq!(plain.count(|r| is_tagging(r, "DELETE")), 1);
    }

    #[tokio::test]
    async fn a_failed_read_back_is_not_a_failed_save() {
        let gets = Arc::new(AtomicUsize::new(0));
        let g = gets.clone();
        let s3 = FakeS3::start(move |r| match r.method.as_str() {
            // The check before the write succeeds; the read-back after it is denied.
            "GET" if g.fetch_add(1, Ordering::SeqCst) == 0 => Reply::xml(200, &tagging(&[("env", "prod")])),
            "GET" => Reply::xml(403, "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"),
            _ => Reply::status(204),
        })
        .await;
        let e = put_bucket_tags(&s3.client(), "b", &[Tag::new("env", "dev")], &[Tag::new("env", "prod")])
            .await
            .expect_err("read-back fails");
        assert_eq!(e.code, ErrorCode::AccessDenied);
        assert!(e.message.starts_with("Saved, but reading back failed: AccessDenied"), "{}", e.message);
        assert!(e.message.ends_with("Reload to see the current state."), "{}", e.message);
        assert_eq!(s3.count(|r| r.method == "PUT"), 1);

        let gets = Arc::new(AtomicUsize::new(0));
        let g = gets.clone();
        let s3 = FakeS3::start(move |r| match r.method.as_str() {
            "GET" if g.fetch_add(1, Ordering::SeqCst) == 0 => Reply::xml(200, &tagging(&[])),
            "GET" => Reply::xml(403, "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"),
            _ => Reply::status(200),
        })
        .await;
        let e = put_object_tags(&s3.client(), "b", "k", &[Tag::new("a", "1")], &[]).await.expect_err("read-back fails");
        assert!(e.message.starts_with("Saved, but reading back failed"), "{}", e.message);
    }

    #[tokio::test]
    async fn http_405_on_an_object_is_a_delete_marker() {
        let s3 = FakeS3::start(|_| {
            Reply::xml(405, "<Error><Code>MethodNotAllowed</Code><Message>The specified method is not allowed against this resource.</Message></Error>")
        })
        .await;
        let e = get_object_tags(&s3.client(), "b", "k").await.expect_err("405");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NoSuchKey, DELETE_MARKER));
        let op = TagOperation { mode: TagMode::Replace, set: vec![Tag::new("a", "1")], remove: vec![] };
        let e = tag_object(&s3.client(), "b", "k", &op).await.expect_err("405");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NoSuchKey, DELETE_MARKER));
        // 501 NotImplemented stays NotSupported.
        let s3 = FakeS3::start(|_| {
            Reply::xml(501, "<Error><Code>NotImplemented</Code><Message>not implemented</Message></Error>")
        })
        .await;
        assert_eq!(get_object_tags(&s3.client(), "b", "k").await.expect_err("501").code, ErrorCode::NotSupported);
    }
}
