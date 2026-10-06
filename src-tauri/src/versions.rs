//! Object versions: listing one key's versions, restoring an older version (copy it over the
//! current one), and permanently deleting one version or delete marker.
//!
//! No Tauri types here. Version ids are opaque strings and are passed through unchanged; `"null"`
//! is a legitimate id (objects written before versioning was enabled, or while it was suspended).

use std::collections::HashSet;

use aws_sdk_s3::Client;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::jobs::plan::{Planned, COPY_OBJECT_MAX};
use crate::models::{clean_etag, fmt_dt, ObjectEntry, ObjectVersion, VersionListing, VERSION_LIST_MAX};

/// `NoSuchKey` naming the version (S3 answers `NoSuchVersion`, or a bare 404 to HeadObject).
pub fn no_such_version(key: &str, version_id: &str) -> AppError {
    AppError::new(ErrorCode::NoSuchKey, format!("Version {version_id} of {key} does not exist."))
}

pub const DELETE_MARKER_RESTORE: &str =
    "This version is a delete marker and has no content to restore. To bring the object back, permanently delete the delete marker.";
pub const DELETE_MARKER_DOWNLOAD: &str = "This version is a delete marker and has no content to download.";
pub const ALREADY_CURRENT: &str = "This version is already the current version.";

/// Most versions scanned when looking for one version id (100 pages of 1,000).
const FIND_SCAN_LIMIT: usize = 100_000;

/// One entry of a `ListObjectVersions` page, before ordering.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub key: String,
    /// Last-modified as (seconds, nanoseconds) for ordering; `None` sorts last.
    pub at: Option<(i64, u32)>,
    pub version: ObjectVersion,
}

fn at(dt: Option<&aws_smithy_types::DateTime>) -> Option<(i64, u32)> {
    dt.map(|d| (d.secs(), d.subsec_nanos()))
}

/// The entries of one page that belong to exactly `key` (byte for byte), versions then delete
/// markers, each in the server's order. A missing version id is `"null"`.
fn page_entries(page: &aws_sdk_s3::operation::list_object_versions::ListObjectVersionsOutput, key: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for v in page.versions() {
        let Some(k) = v.key().filter(|k| *k == key) else { continue };
        out.push(Entry {
            key: k.to_string(),
            at: at(v.last_modified()),
            version: ObjectVersion {
                version_id: v.version_id().filter(|s| !s.is_empty()).unwrap_or("null").to_string(),
                is_latest: v.is_latest().unwrap_or(false),
                is_delete_marker: false,
                size: v.size().unwrap_or(0).max(0) as u64,
                last_modified: fmt_dt(v.last_modified()),
                etag: clean_etag(v.e_tag()),
                storage_class: v.storage_class().map(|s| s.as_str().to_string()),
            },
        });
    }
    for m in page.delete_markers() {
        let Some(k) = m.key().filter(|k| *k == key) else { continue };
        out.push(Entry {
            key: k.to_string(),
            at: at(m.last_modified()),
            version: ObjectVersion {
                version_id: m.version_id().filter(|s| !s.is_empty()).unwrap_or("null").to_string(),
                is_latest: m.is_latest().unwrap_or(false),
                is_delete_marker: true,
                size: 0,
                last_modified: fmt_dt(m.last_modified()),
                etag: None,
                storage_class: None,
            },
        });
    }
    out
}

/// Keeps only `key`'s entries, orders them newest first (last-modified, then the latest one
/// first, then the server's order: servers list each key's versions newest first, and
/// timestamps are often only to the second) and caps at `max` (`truncated` when more were seen
/// or `more` says the listing went on).
pub(crate) fn order_versions(key: &str, entries: Vec<Entry>, more: bool, max: usize) -> VersionListing {
    let mut v: Vec<Entry> = entries.into_iter().filter(|e| e.key == key).collect();
    // Stable: equal keys keep the server's order.
    v.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.version.is_latest.cmp(&a.version.is_latest)));
    let truncated = more || v.len() > max;
    v.truncate(max);
    VersionListing { versions: v.into_iter().map(|e| e.version).collect(), truncated }
}

/// What to do after one `ListObjectVersions` page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NextVersions {
    Done,
    /// Ask again from these markers.
    Continue { key_marker: String, version_id_marker: Option<String> },
    Error(&'static str),
}

/// Paging for one key: the listing is in key order, so once the next key marker is past `key`
/// every version of `key` has been seen. Repeated markers are a server loop (an error, unless the
/// server also said the listing is complete).
pub(crate) fn next_versions(
    key: &str,
    is_truncated: Option<bool>,
    next_key: Option<&str>,
    next_version: Option<&str>,
    seen: &HashSet<(String, Option<String>)>,
) -> NextVersions {
    let next_key = next_key.filter(|k| !k.is_empty());
    let next_version = next_version.filter(|v| !v.is_empty()).map(str::to_string);
    match next_key {
        None if is_truncated == Some(true) => NextVersions::Error("it was truncated without a usable key marker"),
        None => NextVersions::Done,
        Some(_) if is_truncated == Some(false) => NextVersions::Done,
        // Past this key (and all of its versions): nothing more to find.
        Some(k) if k != key => NextVersions::Done,
        Some(k) => {
            if seen.contains(&(k.to_string(), next_version.clone())) {
                NextVersions::Error("the server returned the same markers again")
            } else {
                NextVersions::Continue { key_marker: k.to_string(), version_id_marker: next_version }
            }
        }
    }
}

/// Every version of exactly `key`, in the server's order, stopping once more than `cap` were
/// collected (the flag says whether it stopped early). `Err(NotSupported)` passes through.
async fn scan(client: &Client, bucket: &str, key: &str, cap: usize) -> AppResult<(Vec<Entry>, bool)> {
    let mut out = Vec::new();
    let mut markers: Option<(String, Option<String>)> = None;
    let mut seen: HashSet<(String, Option<String>)> = HashSet::new();
    loop {
        let (km, vm) = markers.clone().unzip();
        let page = client
            .list_object_versions()
            .bucket(bucket)
            .prefix(key)
            .set_key_marker(km)
            .set_version_id_marker(vm.flatten())
            .send()
            .await?;
        out.extend(page_entries(&page, key));
        let next = next_versions(key, page.is_truncated(), page.next_key_marker(), page.next_version_id_marker(), &seen);
        match next {
            NextVersions::Done => return Ok((out, false)),
            NextVersions::Continue { .. } if out.len() > cap => return Ok((out, true)),
            NextVersions::Continue { key_marker, version_id_marker } => {
                seen.insert((key_marker.clone(), version_id_marker.clone()));
                markers = Some((key_marker, version_id_marker));
            }
            NextVersions::Error(why) => {
                return Err(AppError::new(
                    ErrorCode::Unknown,
                    format!("Listing the versions of {key:?} in {bucket} could not be completed: {why}"),
                ))
            }
        }
    }
}

/// The current object as its one `"null"` version (a server that lists nothing for a key that
/// exists, or does not implement `ListObjectVersions`). Empty when the key does not exist.
async fn current_as_null(client: &Client, bucket: &str, key: &str) -> AppResult<Vec<ObjectVersion>> {
    match client.head_object().bucket(bucket).key(key).send().await {
        Ok(h) => Ok(vec![ObjectVersion {
            version_id: h.version_id().filter(|s| !s.is_empty()).unwrap_or("null").to_string(),
            is_latest: true,
            is_delete_marker: false,
            size: h.content_length().unwrap_or(0).max(0) as u64,
            last_modified: fmt_dt(h.last_modified()),
            etag: clean_etag(h.e_tag()),
            storage_class: Some(h.storage_class().map(|s| s.as_str().to_string()).unwrap_or_else(|| "STANDARD".into())),
        }]),
        Err(e) => {
            let e = AppError::from(e);
            if e.code == ErrorCode::NoSuchKey {
                Ok(Vec::new())
            } else {
                Err(e)
            }
        }
    }
}

/// `list_object_versions`: every version and delete marker of exactly `key`, newest first, at
/// most [`VERSION_LIST_MAX`]. A bucket that never had versioning lists the object as its one
/// `"null"` version (S3 does that itself; servers that list nothing get it from `HeadObject`).
pub async fn list_object_versions(client: &Client, bucket: &str, key: &str) -> AppResult<VersionListing> {
    if key.is_empty() {
        return Err(AppError::invalid("Object key is required"));
    }
    let (entries, more) = match scan(client, bucket, key, VERSION_LIST_MAX).await {
        Ok(r) => r,
        Err(e) if e.code == ErrorCode::NotSupported => {
            return Ok(VersionListing { versions: current_as_null(client, bucket, key).await?, truncated: false })
        }
        Err(e) => return Err(e),
    };
    if entries.is_empty() {
        return Ok(VersionListing { versions: current_as_null(client, bucket, key).await?, truncated: false });
    }
    Ok(order_versions(key, entries, more, VERSION_LIST_MAX))
}

/// Looks up one version of `key` (scanning at most [`FIND_SCAN_LIMIT`] versions). `NoSuchKey`
/// naming the version when it is not there.
pub async fn find_version(client: &Client, bucket: &str, key: &str, version_id: &str) -> AppResult<ObjectVersion> {
    if key.is_empty() {
        return Err(AppError::invalid("Object key is required"));
    }
    if version_id.is_empty() {
        return Err(AppError::invalid("versionId is required"));
    }
    let (entries, _) = match scan(client, bucket, key, FIND_SCAN_LIMIT).await {
        Ok(r) => r,
        Err(e) if e.code == ErrorCode::NotSupported && version_id == "null" => {
            let v = current_as_null(client, bucket, key).await?;
            return v.into_iter().find(|v| v.version_id == version_id).ok_or_else(|| no_such_version(key, version_id));
        }
        Err(e) => return Err(e),
    };
    let found = if entries.is_empty() && version_id == "null" {
        current_as_null(client, bucket, key).await?.into_iter().find(|v| v.version_id == version_id)
    } else {
        // `is_latest` comes from the server; the ordering is not needed for one entry.
        entries.into_iter().map(|e| e.version).find(|v| v.version_id == version_id)
    };
    found.ok_or_else(|| no_such_version(key, version_id))
}

/// Maps a copy failure message (it starts with the S3 code where there is one) to an error.
fn copy_error(key: &str, version_id: &str, message: String) -> AppError {
    let code = |prefix: &str| message.starts_with(prefix);
    if code("NoSuchVersion") {
        return no_such_version(key, version_id);
    }
    let c = if code("NoSuchKey") {
        ErrorCode::NoSuchKey
    } else if code("InvalidObjectState") {
        ErrorCode::InvalidInput
    } else if code("PreconditionFailed") {
        ErrorCode::Conflict
    } else if code("AccessDenied") {
        ErrorCode::AccessDenied
    } else {
        ErrorCode::Unknown
    };
    AppError::new(c, message)
}

/// `restore_object_version` with a test-adjustable multipart threshold.
pub(crate) async fn restore_version_with(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: &str,
    multipart_threshold: u64,
) -> AppResult<ObjectEntry> {
    let v = find_version(client, bucket, key, version_id).await?;
    if v.is_delete_marker {
        return Err(AppError::invalid(DELETE_MARKER_RESTORE));
    }
    if v.is_latest {
        return Err(AppError::invalid(ALREADY_CURRENT));
    }
    let p = Planned {
        src: key.to_string(),
        dest: Some(key.to_string()),
        size: v.size,
        // Not pinned by ETag: a version id names immutable content already.
        etag: None,
        storage_class: v.storage_class.clone(),
        item: 0,
        version_id: Some(v.version_id.clone()),
    };
    crate::jobs::engine::copy_version(client, bucket, &p, multipart_threshold)
        .await
        .map_err(|m| copy_error(key, version_id, m))?;
    let meta = crate::ops::head_object(client, bucket, key)
        .await
        .map_err(|e| AppError::saved_but_unread(AppError::new(e.code, format!("the version was restored, but {}", e.message))))?;
    Ok(ObjectEntry {
        key: meta.key,
        name: meta.name,
        size: meta.size,
        last_modified: meta.last_modified,
        etag: meta.etag,
        storage_class: meta.storage_class,
    })
}

/// `restore_object_version`: copies that version over the current one (`CopyObject` with
/// `?versionId=`, metadata/content type/tags/storage class of that version; multipart copy above
/// 5 GiB). The old current version stays as a noncurrent version. Returns the new current object.
pub async fn restore_object_version(client: &Client, bucket: &str, key: &str, version_id: &str) -> AppResult<ObjectEntry> {
    restore_version_with(client, bucket, key, version_id, COPY_OBJECT_MAX).await
}

/// `delete_object_version`: permanently deletes one version (or delete marker) with
/// `DeleteObject` + `versionId`. The version must exist first (S3 answers a delete of a missing
/// version id with success), and it must be gone afterwards; otherwise an error.
pub async fn delete_object_version(client: &Client, bucket: &str, key: &str, version_id: &str) -> AppResult<()> {
    find_version(client, bucket, key, version_id).await?;
    if let Err(e) = client.delete_object().bucket(bucket).key(key).version_id(version_id).send().await {
        let e = AppError::from(e);
        return Err(if e.message.starts_with("NoSuchVersion") { no_such_version(key, version_id) } else { e });
    }
    match find_version(client, bucket, key, version_id).await {
        Err(e) if e.code == ErrorCode::NoSuchKey => Ok(()),
        Ok(_) => Err(AppError::new(
            ErrorCode::Unknown,
            format!("The server answered the delete, but version {version_id} of {key} is still listed. Nothing was confirmed deleted."),
        )),
        Err(e) => Err(AppError::new(
            e.code,
            format!("The delete was sent, but it could not be confirmed ({}). Reload the versions to see the current state.", e.message),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{h, FakeS3, Reply};

    fn e(key: &str, id: &str, secs: Option<i64>, latest: bool, marker: bool) -> Entry {
        Entry {
            key: key.into(),
            at: secs.map(|s| (s, 0)),
            version: ObjectVersion {
                version_id: id.into(),
                is_latest: latest,
                is_delete_marker: marker,
                size: if marker { 0 } else { 1 },
                last_modified: None,
                etag: None,
                storage_class: None,
            },
        }
    }
    fn ids(l: &VersionListing) -> Vec<&str> {
        l.versions.iter().map(|v| v.version_id.as_str()).collect()
    }

    #[test]
    fn ordering_filtering_and_cap() {
        // Versions and markers come in separate lists; other keys under the prefix are dropped.
        let entries = vec![
            e("k", "v3", Some(30), false, false),
            e("k", "v1", Some(10), false, false),
            e("k.bak", "x", Some(99), true, false),
            e("K", "y", Some(98), true, false),
            e("k", "m2", Some(20), false, true),
            e("k", "m4", Some(40), true, true),
        ];
        let l = order_versions("k", entries, false, 1000);
        assert_eq!(ids(&l), ["m4", "v3", "m2", "v1"]);
        assert!(!l.truncated);
        assert!(l.versions[0].is_latest && l.versions[0].is_delete_marker);

        // Same second: the latest first, then the server's order.
        let same = vec![e("k", "a", Some(5), false, false), e("k", "b", Some(5), false, false), e("k", "m", Some(5), true, true)];
        assert_eq!(ids(&order_versions("k", same, false, 1000)), ["m", "a", "b"]);
        // Undated entries sort last.
        let undated = vec![e("k", "u", None, false, false), e("k", "d", Some(1), true, false)];
        assert_eq!(ids(&order_versions("k", undated, false, 1000)), ["d", "u"]);

        // Cap: more entries than the cap, or more pages, is truncated.
        let many: Vec<Entry> = (0..1005).map(|i| e("k", &format!("v{i}"), Some(10_000 - i), i == 0, false)).collect();
        let l = order_versions("k", many, false, 1000);
        assert_eq!(l.versions.len(), 1000);
        assert!(l.truncated);
        assert_eq!(l.versions[0].version_id, "v0");
        assert_eq!(l.versions[999].version_id, "v999", "the newest 1,000");
        let l = order_versions("k", vec![e("k", "a", Some(1), true, false)], true, 1000);
        assert!(l.truncated, "the listing went on");
        // Keys are compared byte for byte.
        let odd = vec![e("a//b ", "1", Some(1), true, false), e("a/b", "2", Some(2), true, false)];
        assert_eq!(ids(&order_versions("a//b ", odd, false, 1000)), ["1"]);
    }

    #[test]
    fn paging_decisions() {
        let none = HashSet::new();
        let cont = |k: &str, v: Option<&str>| NextVersions::Continue { key_marker: k.into(), version_id_marker: v.map(Into::into) };
        assert_eq!(next_versions("k", Some(false), None, None, &none), NextVersions::Done);
        assert_eq!(next_versions("k", None, None, None, &none), NextVersions::Done);
        assert_eq!(next_versions("k", Some(true), Some("k"), Some("v2"), &none), cont("k", Some("v2")));
        assert_eq!(next_versions("k", None, Some("k"), Some("v2"), &none), cont("k", Some("v2")), "missing IsTruncated");
        assert_eq!(next_versions("k", Some(true), Some("k.bak"), Some("x"), &none), NextVersions::Done, "past the key");
        assert_eq!(next_versions("k", Some(false), Some("k"), Some("v2"), &none), NextVersions::Done);
        assert!(matches!(next_versions("k", Some(true), None, None, &none), NextVersions::Error(_)));
        let mut seen = HashSet::new();
        seen.insert(("k".to_string(), Some("v2".to_string())));
        assert!(matches!(next_versions("k", Some(true), Some("k"), Some("v2"), &seen), NextVersions::Error(_)));
        assert_eq!(next_versions("k", Some(true), Some("k"), Some("v3"), &seen), cont("k", Some("v3")));
    }

    fn versions_xml(versions: &[(&str, &str, bool, &str)], markers: &[(&str, &str, bool, &str)], next: Option<(&str, &str)>) -> String {
        let mut x = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult><Name>b</Name>"#);
        match next {
            Some((k, v)) => x.push_str(&format!(
                "<IsTruncated>true</IsTruncated><NextKeyMarker>{k}</NextKeyMarker><NextVersionIdMarker>{v}</NextVersionIdMarker>"
            )),
            None => x.push_str("<IsTruncated>false</IsTruncated>"),
        }
        for (k, id, latest, lm) in versions {
            x.push_str(&format!(
                "<Version><Key>{k}</Key><VersionId>{id}</VersionId><IsLatest>{latest}</IsLatest><LastModified>{lm}</LastModified><ETag>\"e-{id}\"</ETag><Size>7</Size><StorageClass>STANDARD</StorageClass></Version>"
            ));
        }
        for (k, id, latest, lm) in markers {
            x.push_str(&format!(
                "<DeleteMarker><Key>{k}</Key><VersionId>{id}</VersionId><IsLatest>{latest}</IsLatest><LastModified>{lm}</LastModified></DeleteMarker>"
            ));
        }
        x.push_str("</ListVersionsResult>");
        x
    }

    const T1: &str = "2026-01-01T00:00:01.000Z";
    const T2: &str = "2026-01-01T00:00:02.000Z";
    const T3: &str = "2026-01-01T00:00:03.000Z";

    #[tokio::test]
    async fn list_pages_with_both_markers_and_stops_past_the_key() {
        let s3 = FakeS3::start(|r| {
            if r.query.contains("version-id-marker=v2") {
                Reply::xml(200, &versions_xml(&[("k", "v1", false, T1), ("k.bak", "b", true, T3)], &[], Some(("k.bak", "b"))))
            } else {
                Reply::xml(200, &versions_xml(&[("k", "v2", false, T2)], &[("k", "m3", true, T3)], Some(("k", "v2"))))
            }
        })
        .await;
        let l = list_object_versions(&s3.client(), "b", "k").await.expect("list");
        assert_eq!(ids(&l), ["m3", "v2", "v1"]);
        assert!(!l.truncated);
        assert_eq!(l.versions[1].etag.as_deref(), Some("e-v2"));
        assert_eq!(l.versions[1].last_modified.as_deref(), Some("2026-01-01T00:00:02Z"));
        assert_eq!(s3.requests().len(), 2, "stops once the key marker moved past the key");
        let second = &s3.requests()[1];
        assert!(second.query.contains("key-marker=k") && second.query.contains("version-id-marker=v2"), "{}", second.query);
        assert!(s3.requests()[0].query.contains("prefix=k"), "{}", s3.requests()[0].query);
    }

    #[tokio::test]
    async fn never_versioned_and_empty_listings() {
        // S3 lists an unversioned object as version "null".
        let s3 = FakeS3::start(|_| Reply::xml(200, &versions_xml(&[("k", "null", true, T1)], &[], None))).await;
        let l = list_object_versions(&s3.client(), "b", "k").await.expect("list");
        assert_eq!(ids(&l), ["null"]);
        // A server that lists nothing: the current object becomes the "null" version.
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => Reply::with_headers(200, vec![h("Content-Length", "4"), h("ETag", "\"abc\"")]),
            _ => Reply::xml(200, &versions_xml(&[], &[], None)),
        })
        .await;
        let l = list_object_versions(&s3.client(), "b", "k").await.expect("list");
        assert_eq!(ids(&l), ["null"]);
        assert!(l.versions[0].is_latest && l.versions[0].size == 4 && l.versions[0].etag.as_deref() == Some("abc"));
        // ...and nothing at all when the key does not exist.
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => Reply::status(404),
            _ => Reply::xml(200, &versions_xml(&[], &[], None)),
        })
        .await;
        assert!(list_object_versions(&s3.client(), "b", "k").await.expect("list").versions.is_empty());
    }

    /// A versioned key: v1 (oldest), v2, v3 (current); `marker` adds a delete marker on top.
    async fn versioned(marker: bool) -> FakeS3 {
        FakeS3::start(move |r| match r.method.as_str() {
            "GET" if r.has_query("versions") => {
                let markers: Vec<(&str, &str, bool, &str)> =
                    if marker { vec![("k", "dm", true, "2026-01-01T00:00:04.000Z")] } else { vec![] };
                Reply::xml(200, &versions_xml(&[("k", "v3", !marker, T3), ("k", "v2", false, T2), ("k", "v1", false, T1)], &markers, None))
            }
            "PUT" if r.header("x-amz-copy-source").is_some() => Reply::xml(
                200,
                r#"<CopyObjectResult><ETag>"e-v1"</ETag><LastModified>2026-01-02T00:00:00.000Z</LastModified></CopyObjectResult>"#,
            ),
            "HEAD" => Reply::with_headers(200, vec![h("Content-Length", "7"), h("ETag", "\"e-v1\"")]),
            "DELETE" => Reply::status(204),
            _ => Reply::status(500),
        })
        .await
    }

    #[tokio::test]
    async fn restore_copies_that_version_onto_the_key() {
        let s3 = versioned(false).await;
        let entry = restore_object_version(&s3.client(), "b", "k", "v1").await.expect("restore");
        assert_eq!((entry.key.as_str(), entry.etag.as_deref()), ("k", Some("e-v1")));
        let copy = s3.requests().into_iter().find(|r| r.method == "PUT").expect("copy");
        assert_eq!(copy.path, "/b/k");
        assert_eq!(copy.header("x-amz-copy-source"), Some("b/k?versionId=v1"));
        assert_eq!(copy.header("x-amz-metadata-directive"), Some("COPY"));
        assert_eq!(copy.header("x-amz-storage-class"), Some("STANDARD"), "the version's storage class");
        assert!(copy.header("x-amz-copy-source-if-match").is_none());
        assert!(copy.header("if-none-match").is_none(), "the current version exists: never If-None-Match");

        let e = restore_object_version(&s3.client(), "b", "k", "v3").await.expect_err("latest");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ALREADY_CURRENT));
        let e = restore_object_version(&s3.client(), "b", "k", "nope").await.expect_err("missing");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NoSuchKey, "Version nope of k does not exist."));
        let s3 = versioned(true).await;
        let e = restore_object_version(&s3.client(), "b", "k", "dm").await.expect_err("marker");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, DELETE_MARKER_RESTORE));
        // v3 is no longer the latest once a delete marker is on top: restoring it undoes the delete.
        restore_object_version(&s3.client(), "b", "k", "v3").await.expect("restore under a marker");
        assert_eq!(s3.count(|r| r.method == "PUT"), 1);
    }

    #[tokio::test]
    async fn restore_above_the_copy_limit_uses_multipart_copy_of_that_version() {
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "GET" if r.has_query("versions") => {
                Reply::xml(200, &versions_xml(&[("k", "v2", true, T2), ("k", "v1", false, T1)], &[], None))
            }
            "GET" if r.has_query("tagging") => Reply::xml(200, r#"<Tagging><TagSet><Tag><Key>a</Key><Value>b</Value></Tag></TagSet></Tagging>"#),
            "HEAD" => Reply::with_headers(200, vec![h("Content-Length", "7"), h("ETag", "\"e-v1\""), h("Content-Type", "text/plain")]),
            "POST" if r.has_query("uploads") => Reply::xml(200, "<InitiateMultipartUploadResult><UploadId>U</UploadId></InitiateMultipartUploadResult>"),
            "PUT" if r.has_query("partNumber") => Reply::xml(200, r#"<CopyPartResult><ETag>"p1"</ETag></CopyPartResult>"#),
            "POST" if r.has_query("uploadId") => Reply::xml(200, r#"<CompleteMultipartUploadResult><ETag>"m-1"</ETag></CompleteMultipartUploadResult>"#),
            _ => Reply::status(500),
        })
        .await;
        restore_version_with(&s3.client(), "b", "k", "v1", 1).await.expect("multipart restore");
        let reqs = s3.requests();
        let head = reqs.iter().find(|r| r.method == "HEAD").expect("head");
        assert!(head.query.contains("versionId=v1"), "{}", head.query);
        let tagging = reqs.iter().find(|r| r.has_query("tagging")).expect("tagging");
        assert!(tagging.query.contains("versionId=v1"), "{}", tagging.query);
        let part = reqs.iter().find(|r| r.has_query("partNumber")).expect("part");
        assert_eq!(part.header("x-amz-copy-source"), Some("b/k?versionId=v1"));
        let create = reqs.iter().find(|r| r.has_query("uploads")).expect("create");
        assert_eq!(create.header("x-amz-tagging"), Some("a=b"));
        assert_eq!(create.header("content-type"), Some("text/plain"));
    }

    #[tokio::test]
    async fn delete_checks_before_and_after() {
        // The version is gone after the delete.
        let deleted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let d = deleted.clone();
        let s3 = FakeS3::start(move |r| match r.method.as_str() {
            "GET" => {
                let gone = d.load(std::sync::atomic::Ordering::SeqCst);
                let mut v = vec![("k", "v2", true, T2)];
                if !gone {
                    v.push(("k", "v1", false, T1));
                }
                Reply::xml(200, &versions_xml(&v, &[], None))
            }
            "DELETE" => {
                d.store(true, std::sync::atomic::Ordering::SeqCst);
                Reply::status(204)
            }
            _ => Reply::status(500),
        })
        .await;
        delete_object_version(&s3.client(), "b", "k", "v1").await.expect("delete");
        let del = s3.requests().into_iter().find(|r| r.method == "DELETE").expect("delete");
        assert_eq!(del.path, "/b/k");
        assert!(del.query.contains("versionId=v1"), "{}", del.query);
        // A missing version: nothing is sent (S3 would answer 204 anyway).
        let e = delete_object_version(&s3.client(), "b", "k", "v9").await.expect_err("missing");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NoSuchKey, "Version v9 of k does not exist."));
        assert_eq!(s3.count(|r| r.method == "DELETE"), 1);

        // A server that answers 204 but keeps the version: not confirmed.
        let s3 = versioned(false).await;
        let e = delete_object_version(&s3.client(), "b", "k", "v1").await.expect_err("still listed");
        assert_eq!(e.code, ErrorCode::Unknown);
        assert!(e.message.contains("is still listed"), "{}", e.message);
    }

    #[test]
    fn no_such_version_mapping() {
        let e = copy_error("k", "v1", "NoSuchVersion: The specified version does not exist.".into());
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NoSuchKey, "Version v1 of k does not exist."));
        assert_eq!(copy_error("k", "v", "InvalidObjectState: archived".into()).code, ErrorCode::InvalidInput);
        assert_eq!(copy_error("k", "v", "AccessDenied: no".into()).code, ErrorCode::AccessDenied);
        assert_eq!(copy_error("k", "v", "whatever".into()).code, ErrorCode::Unknown);
    }
}
