//! Edit an object's content type, Cache-Control, Content-Disposition and user metadata by copying
//! it onto itself with `MetadataDirective=REPLACE` ("Edit content type and metadata" in
//! docs/CONTRACT.md). S3 cannot change these headers in place.

use aws_config::timeout::TimeoutConfig;
use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::operation::head_object::HeadObjectOutput;
use aws_sdk_s3::primitives::{DateTime, DateTimeFormat};
use aws_sdk_s3::types::{MetadataDirective, TaggingDirective};
use aws_sdk_s3::Client;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::jobs::engine::copy_timeout_for;
use crate::jobs::plan::encode_copy_source;
use crate::models::{clean_etag, MetadataEdit, ObjectMeta};
use crate::ops::meta_from_head;

/// User metadata limit: keys + values in UTF-8 bytes, as S3 counts it (`METADATA_LIMITS` in `types.ts`).
pub const MAX_TOTAL_BYTES: usize = 2048;
pub const MAX_KEY_CHARS: usize = 128;
pub const MAX_CONTENT_TYPE_CHARS: usize = 255;
/// The largest object a single `CopyObject` can copy.
pub const MAX_COPY_BYTES: u64 = 5 * 1024 * 1024 * 1024;

const CHANGED: &str =
    "The object changed since the dialog opened, so nothing was written. Reload to edit the current version.";

fn printable(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// Header values must survive the round trip byte for byte: printable ASCII (S3 stores anything
/// else RFC 2047-encoded) and no leading or trailing spaces (HTTP trims them).
fn header_error(s: &str) -> Option<&'static str> {
    if s.is_empty() {
        Some("must not be empty")
    } else if s.chars().any(char::is_control) {
        Some("must not contain control characters")
    } else if !printable(s) {
        Some("must be plain ASCII (S3 would store other characters encoded)")
    } else if s.trim() != s {
        Some("must not start or end with a space")
    } else {
        None
    }
}

/// Rejects anything that could not be written and read back exactly, before any request.
pub fn validate(edit: &MetadataEdit) -> AppResult<()> {
    if edit.bucket.trim().is_empty() {
        return Err(AppError::invalid("Bucket name is required"));
    }
    if edit.key.is_empty() {
        return Err(AppError::invalid("Object key is required"));
    }
    if clean_etag(Some(&edit.expected_etag)).unwrap_or_default().is_empty() {
        return Err(AppError::invalid("The object's ETag is required"));
    }
    expected_last_modified(edit)?;
    if let Some(why) = header_error(&edit.content_type) {
        return Err(AppError::invalid(format!("Content type {why}.")));
    }
    if edit.content_type.chars().count() > MAX_CONTENT_TYPE_CHARS {
        return Err(AppError::invalid(format!("Content type must be at most {MAX_CONTENT_TYPE_CHARS} characters.")));
    }
    for (name, v) in [("Cache-Control", &edit.cache_control), ("Content-Disposition", &edit.content_disposition)] {
        if let Some(why) = v.as_deref().and_then(header_error) {
            return Err(AppError::invalid(format!("{name} {why}.")));
        }
    }
    let mut keys: Vec<&String> = edit.metadata.keys().collect();
    keys.sort();
    let mut total = 0;
    for k in keys {
        if k.is_empty() {
            return Err(AppError::invalid("A metadata key is empty."));
        }
        if k.chars().count() > MAX_KEY_CHARS {
            return Err(AppError::invalid(format!("Metadata key {k:?} is longer than {MAX_KEY_CHARS} characters.")));
        }
        if !k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err(AppError::invalid(format!(
                "Metadata key {k:?} may only contain lowercase letters a-z, digits and hyphens."
            )));
        }
        let v = &edit.metadata[k];
        if let Some(why) = header_error(v) {
            return Err(AppError::invalid(format!("The value of metadata key {k:?} {why}.")));
        }
        total += k.len() + v.len();
    }
    if total > MAX_TOTAL_BYTES {
        return Err(AppError::invalid(format!(
            "User metadata is {total} bytes; S3 allows at most {MAX_TOTAL_BYTES} (keys and values together)."
        )));
    }
    Ok(())
}

/// `expected_last_modified` as a timestamp (S3 keeps whole seconds).
fn expected_last_modified(edit: &MetadataEdit) -> AppResult<DateTime> {
    DateTime::from_str(&edit.expected_last_modified, DateTimeFormat::DateTime)
        .map_err(|_| AppError::invalid("The object's last-modified time is missing or not an ISO-8601 timestamp."))
}

/// Refusals that depend on the object itself, read by the first `HeadObject`.
fn check_object(edit: &MetadataEdit, h: &HeadObjectOutput) -> AppResult<()> {
    // The ETag catches a new body; LastModified also catches another client's metadata-only edit,
    // which keeps a single-part ETag (it is the body's MD5).
    let expected_lm = expected_last_modified(edit)?;
    if clean_etag(h.e_tag()) != clean_etag(Some(&edit.expected_etag))
        || h.last_modified().map(|d| d.secs()) != Some(expected_lm.secs())
    {
        return Err(AppError::new(ErrorCode::Conflict, CHANGED));
    }
    let size = h.content_length().unwrap_or(0).max(0) as u64;
    if size > MAX_COPY_BYTES {
        return Err(AppError::invalid(
            "The object is larger than 5 GiB, the most S3 can copy in one request, so its metadata cannot be edited here.",
        ));
    }
    if crate::archive::ArchiveInfo::from_head(h).archived(chrono::Utc::now()) {
        return Err(AppError::invalid("The object is archived; restore it first to edit its metadata."));
    }
    if h.sse_customer_algorithm().is_some() {
        return Err(AppError::invalid(
            "The object is encrypted with a customer-provided key (SSE-C), which this app cannot copy.",
        ));
    }
    expires_of(h).map(|_| ())
}

/// `Expires` is carried over (REPLACE would drop it); one that cannot be parsed back is refused
/// rather than lost.
fn expires_of(h: &HeadObjectOutput) -> AppResult<Option<DateTime>> {
    match h.expires_string() {
        None => Ok(None),
        Some(s) => DateTime::from_str(s, DateTimeFormat::HttpDate).map(Some).map_err(|_| {
            AppError::invalid(format!("The object's Expires header ({s:?}) cannot be carried over, so it was not edited."))
        }),
    }
}

/// What differs between the edit and the read-back object (`None` = everything matches).
fn mismatch(edit: &MetadataEdit, before: &HeadObjectOutput, copy_etag: Option<&str>, after: &HeadObjectOutput) -> Option<&'static str> {
    let class = |h: &HeadObjectOutput| h.storage_class().map(|s| s.as_str().to_string()).unwrap_or_else(|| "STANDARD".into());
    if after.content_type() != Some(edit.content_type.as_str()) {
        Some("content type")
    } else if after.cache_control() != edit.cache_control.as_deref() {
        Some("Cache-Control")
    } else if after.content_disposition() != edit.content_disposition.as_deref() {
        Some("Content-Disposition")
    } else if after.metadata().cloned().unwrap_or_default() != edit.metadata {
        Some("user metadata")
    } else if after.content_length() != before.content_length() {
        Some("size")
    } else if class(after) != class(before) {
        Some("storage class")
    } else if copy_etag.is_some() && clean_etag(after.e_tag()) != clean_etag(copy_etag) {
        Some("ETag (the object was written again after the edit)")
    } else if matches!((before.tag_count(), after.tag_count()), (Some(a), Some(b)) if a != b) {
        Some("tag count")
    } else {
        None
    }
}

pub async fn update_object_metadata(client: &Client, edit: &MetadataEdit) -> AppResult<ObjectMeta> {
    validate(edit)?;
    let (bucket, key) = (edit.bucket.as_str(), edit.key.as_str());
    let before = client.head_object().bucket(bucket).key(key).send().await?;
    check_object(edit, &before)?;
    let size = before.content_length().unwrap_or(0).max(0) as u64;
    let timeout = copy_timeout_for(size);
    let expected = format!("\"{}\"", edit.expected_etag.trim_matches('"'));
    let sent = client
        .copy_object()
        .bucket(bucket)
        .key(key)
        .copy_source(encode_copy_source(bucket, key))
        .copy_source_if_match(expected)
        // AWS ignores this one when the If-Match holds (RFC 7232), so the HeadObject check above is the
        // guard there; servers that evaluate both get it on the copy itself.
        .copy_source_if_unmodified_since(expected_last_modified(edit)?)
        .metadata_directive(MetadataDirective::Replace)
        .tagging_directive(TaggingDirective::Copy)
        .content_type(&edit.content_type)
        .set_cache_control(edit.cache_control.clone())
        .set_content_disposition(edit.content_disposition.clone())
        .set_metadata(Some(edit.metadata.clone()))
        // Kept from the object as it is: REPLACE would otherwise reset them.
        .set_storage_class(before.storage_class().cloned())
        .set_server_side_encryption(before.server_side_encryption().cloned())
        .set_ssekms_key_id(before.ssekms_key_id().map(str::to_string))
        .set_bucket_key_enabled(before.bucket_key_enabled())
        .set_content_encoding(before.content_encoding().map(str::to_string))
        .set_content_language(before.content_language().map(str::to_string))
        .set_website_redirect_location(before.website_redirect_location().map(str::to_string))
        .set_expires(expires_of(&before)?)
        .customize()
        .config_override(
            aws_sdk_s3::config::Builder::default()
                .timeout_config(TimeoutConfig::builder().read_timeout(timeout).operation_attempt_timeout(timeout).build()),
        )
        // Not cancellable: the copy is one request and either lands or not.
        .send()
        .await;
    let copy_etag = match sent {
        Ok(out) => match out.copy_object_result().and_then(|r| r.e_tag()) {
            Some(e) => e.to_string(),
            None => {
                return Err(AppError::new(
                    ErrorCode::Unknown,
                    "The server did not confirm the copy (no ETag in the response). Reload to see the current state.",
                ))
            }
        },
        Err(e) => {
            let status = e.raw_response().map(|r| r.status().as_u16());
            let code = e.as_service_error().and_then(|s| s.code()).map(str::to_string);
            if status == Some(412) || code.as_deref() == Some("PreconditionFailed") {
                return Err(AppError::new(ErrorCode::Conflict, CHANGED));
            }
            return Err(AppError::from(e));
        }
    };
    let after = client.head_object().bucket(bucket).key(key).send().await.map_err(|e| AppError::saved_but_unread(e.into()))?;
    if let Some(field) = mismatch(edit, &before, Some(&copy_etag), &after) {
        return Err(AppError::new(
            ErrorCode::Unknown,
            format!("The edit was written but the object read back has a different {field}. Reload to see the current state."),
        ));
    }
    Ok(meta_from_head(key, &after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{h, FakeS3, Reply};

    fn edit(metadata: &[(&str, &str)]) -> MetadataEdit {
        MetadataEdit {
            bucket: "b".into(),
            key: "dir/a b+?.txt".into(),
            expected_etag: "abc".into(),
            expected_last_modified: "2026-10-01T10:00:00Z".into(),
            content_type: "text/plain".into(),
            cache_control: Some("max-age=60".into()),
            content_disposition: None,
            metadata: metadata.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    fn invalid(e: &MetadataEdit) -> String {
        let err = validate(e).expect_err("should be refused");
        assert_eq!(err.code, ErrorCode::InvalidInput, "{}", err.message);
        err.message
    }

    #[test]
    fn accepts_a_normal_edit() {
        validate(&edit(&[("owner", "team-a"), ("x-1", "a b=c; d")])).expect("valid");
        validate(&edit(&[])).expect("no metadata is valid");
    }

    #[test]
    fn metadata_keys_are_lowercase_ascii() {
        for k in ["Owner", "my_key", "a.b", "a b", "é", ""] {
            invalid(&edit(&[(k, "v")]));
        }
        let long = "a".repeat(MAX_KEY_CHARS);
        validate(&edit(&[(&long, "v")])).expect("128 chars");
        assert!(invalid(&edit(&[(&format!("{long}a"), "v")])).contains("128"));
    }

    #[test]
    fn values_are_printable_ascii_without_edge_spaces() {
        for v in ["a\nb", "tab\there", "\u{7f}", "caf\u{e9}", " lead", "trail ", ""] {
            invalid(&edit(&[("k", v)]));
        }
    }

    #[test]
    fn total_size_counts_keys_and_values() {
        // 2048 bytes exactly: 8 keys of 6 chars + values of 250.
        let pairs: Vec<(String, String)> = (0..8).map(|i| (format!("key-0{i}"), "v".repeat(250))).collect();
        let mut e = edit(&[]);
        e.metadata = pairs.iter().cloned().collect();
        validate(&e).expect("2048 bytes is the limit");
        e.metadata.insert("z".into(), "1".into());
        assert!(invalid(&e).contains("2050 bytes"));
    }

    #[test]
    fn header_fields() {
        let mut e = edit(&[]);
        e.content_type = String::new();
        invalid(&e);
        e.content_type = "text/plain ".into();
        invalid(&e);
        e.content_type = "a".repeat(256);
        invalid(&e);
        e.content_type = "a".repeat(255);
        validate(&e).expect("255 chars");
        e.cache_control = Some(String::new());
        assert!(invalid(&e).contains("Cache-Control"));
        e.cache_control = None;
        e.content_disposition = Some("attachment; filename=\"r\u{e9}sum\u{e9}.pdf\"".into());
        assert!(invalid(&e).contains("Content-Disposition"));
        e.content_disposition = Some("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf".into());
        validate(&e).expect("encoded filename");
        e.expected_etag = "\"\"".into();
        invalid(&e);
    }

    const LM: &str = "Thu, 01 Oct 2026 10:00:00 GMT";

    fn head_reply(etag: &str, extra: Vec<(String, String)>) -> Reply {
        let mut hs = vec![
            h("Content-Length", "5"),
            h("ETag", &format!("\"{etag}\"")),
            h("Content-Type", "text/plain"),
            h("Last-Modified", LM),
        ];
        hs.extend(extra);
        Reply::with_headers(200, hs)
    }

    #[tokio::test]
    async fn stale_etag_writes_nothing() {
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => head_reply("new", vec![]),
            _ => Reply::status(500),
        })
        .await;
        let err = update_object_metadata(&s3.client(), &edit(&[])).await.expect_err("conflict");
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(err.message.contains("nothing was written"));
        assert_eq!(s3.count(|r| r.method == "PUT"), 0, "no copy was sent");
    }

    /// Same ETag, newer LastModified: another client changed only the metadata.
    #[tokio::test]
    async fn metadata_only_change_by_someone_else_writes_nothing() {
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => Reply::with_headers(
                200,
                vec![h("Content-Length", "5"), h("ETag", "\"abc\""), h("Last-Modified", "Thu, 01 Oct 2026 10:00:01 GMT")],
            ),
            _ => Reply::status(500),
        })
        .await;
        let err = update_object_metadata(&s3.client(), &edit(&[])).await.expect_err("conflict");
        assert_eq!(err.code, ErrorCode::Conflict, "{}", err.message);
        assert_eq!(s3.count(|r| r.method == "PUT"), 0, "no copy was sent");
    }

    #[test]
    fn last_modified_must_be_a_timestamp() {
        let mut e = edit(&[]);
        for bad in ["", "yesterday", "2026-10-01"] {
            e.expected_last_modified = bad.into();
            assert!(invalid(&e).contains("last-modified"));
        }
        e.expected_last_modified = "2026-10-01T10:00:00.000Z".into();
        validate(&e).expect("with fractional seconds");
    }

    #[tokio::test]
    async fn precondition_failed_on_copy_is_a_conflict() {
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => head_reply("abc", vec![]),
            _ => Reply::xml(412, "<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>"),
        })
        .await;
        let err = update_object_metadata(&s3.client(), &edit(&[])).await.expect_err("conflict");
        assert_eq!(err.code, ErrorCode::Conflict, "{}", err.message);
        assert_eq!(s3.count(|r| r.method == "HEAD"), 1, "no read-back after a refused copy");
    }

    #[tokio::test]
    async fn refuses_large_archived_and_sse_c_objects_without_copying() {
        let cases: Vec<(Vec<(String, String)>, &str)> = vec![
            (vec![h("Content-Length", &(MAX_COPY_BYTES + 1).to_string())], "5 GiB"),
            (vec![h("x-amz-storage-class", "GLACIER")], "archived"),
            (vec![h("x-amz-server-side-encryption-customer-algorithm", "AES256")], "SSE-C"),
            (vec![h("Expires", "not a date")], "Expires"),
        ];
        for (extra, what) in cases {
            let s3 = FakeS3::start(move |r| match r.method.as_str() {
                "HEAD" => {
                    let mut hs = vec![h("ETag", "\"abc\""), h("Content-Type", "text/plain"), h("Last-Modified", LM)];
                    if !extra.iter().any(|(k, _)| k == "Content-Length") {
                        hs.push(h("Content-Length", "5"));
                    }
                    hs.extend(extra.clone());
                    Reply::with_headers(200, hs)
                }
                _ => Reply::status(500),
            })
            .await;
            let err = update_object_metadata(&s3.client(), &edit(&[])).await.expect_err(what);
            assert_eq!(err.code, ErrorCode::InvalidInput, "{what}: {}", err.message);
            assert!(err.message.contains(what), "{what}: {}", err.message);
            assert_eq!(s3.count(|r| r.method == "PUT"), 0, "{what}: no copy");
        }
    }

    /// The copy request carries the new headers, the condition and every header REPLACE would drop.
    #[tokio::test]
    async fn copy_request_keeps_what_it_must() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let copied = Arc::new(AtomicBool::new(false));
        let c2 = copied.clone();
        let s3 = FakeS3::start(move |r| match r.method.as_str() {
            "HEAD" if !c2.load(Ordering::SeqCst) => head_reply(
                "abc",
                vec![
                    h("x-amz-storage-class", "STANDARD_IA"),
                    h("x-amz-server-side-encryption", "aws:kms"),
                    h("x-amz-server-side-encryption-aws-kms-key-id", "arn:k"),
                    h("x-amz-server-side-encryption-bucket-key-enabled", "true"),
                    h("Content-Encoding", "gzip"),
                    h("Content-Language", "en"),
                    h("Expires", "Wed, 21 Oct 2026 07:28:00 GMT"),
                    h("x-amz-website-redirect-location", "/x"),
                    h("x-amz-meta-old", "gone"),
                    h("x-amz-tagging-count", "2"),
                ],
            ),
            "HEAD" => Reply::with_headers(
                200,
                vec![
                    h("Content-Length", "5"),
                    h("ETag", "\"new\""),
                    h("Content-Type", "text/plain"),
                    h("Cache-Control", "max-age=60"),
                    h("x-amz-storage-class", "STANDARD_IA"),
                    h("x-amz-meta-owner", "team-a"),
                    h("x-amz-tagging-count", "2"),
                ],
            ),
            _ => {
                c2.store(true, Ordering::SeqCst);
                Reply::xml(200, "<CopyObjectResult><ETag>\"new\"</ETag></CopyObjectResult>")
            }
        })
        .await;
        let m = update_object_metadata(&s3.client(), &edit(&[("owner", "team-a")])).await.expect("edited");
        assert_eq!(m.etag.as_deref(), Some("new"));
        assert_eq!(m.cache_control.as_deref(), Some("max-age=60"));
        let reqs = s3.requests();
        let put = reqs.iter().find(|r| r.method == "PUT").expect("copy");
        assert_eq!(put.path, "/b/dir/a%20b%2B%3F.txt");
        let want = [
            ("x-amz-copy-source", "b/dir/a%20b%2B%3F.txt"),
            ("x-amz-copy-source-if-match", "\"abc\""),
            ("x-amz-copy-source-if-unmodified-since", LM),
            ("x-amz-metadata-directive", "REPLACE"),
            ("x-amz-tagging-directive", "COPY"),
            ("content-type", "text/plain"),
            ("cache-control", "max-age=60"),
            ("x-amz-meta-owner", "team-a"),
            ("x-amz-storage-class", "STANDARD_IA"),
            ("x-amz-server-side-encryption", "aws:kms"),
            ("x-amz-server-side-encryption-aws-kms-key-id", "arn:k"),
            ("x-amz-server-side-encryption-bucket-key-enabled", "true"),
            ("content-encoding", "gzip"),
            ("content-language", "en"),
            ("expires", "Wed, 21 Oct 2026 07:28:00 GMT"),
            ("x-amz-website-redirect-location", "/x"),
        ];
        for (k, v) in want {
            assert_eq!(put.header(k), Some(v), "{k}");
        }
        assert_eq!(put.header("content-disposition"), None);
        assert_eq!(put.header("x-amz-meta-old"), None, "the old set is replaced");
    }

    #[tokio::test]
    async fn read_back_mismatch_and_missing_confirmation_are_not_success() {
        // The server answers the copy but the read-back still has the old content type.
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => head_reply("abc", vec![h("Cache-Control", "max-age=60")]),
            _ => Reply::xml(200, "<CopyObjectResult><ETag>\"abc\"</ETag></CopyObjectResult>"),
        })
        .await;
        let mut e = edit(&[]);
        e.content_type = "text/csv".into();
        let err = update_object_metadata(&s3.client(), &e).await.expect_err("mismatch");
        assert_eq!(err.code, ErrorCode::Unknown);
        assert!(err.message.contains("content type"), "{}", err.message);

        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => head_reply("abc", vec![]),
            _ => Reply::xml(200, "<CopyObjectResult></CopyObjectResult>"),
        })
        .await;
        let err = update_object_metadata(&s3.client(), &edit(&[])).await.expect_err("unconfirmed");
        assert_eq!(err.code, ErrorCode::Unknown);
        assert!(err.message.contains("did not confirm"));
    }
}
