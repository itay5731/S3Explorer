//! Buckets added by name ("Shared with me"): input parsing, verification and the per-connection
//! store `added-buckets.json` (app config dir).
//!
//! Free of Tauri types. The store follows the same rules as the other config files: atomic
//! writes, and loading never fails (a missing or corrupt file is empty; bad entries are skipped).
//! Removing an added bucket only forgets it locally: nothing here ever writes to S3.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aws_sdk_s3::Client;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{now_iso, AddedBucket};
use crate::settings::write_json_atomic;

pub const ADDED_BUCKETS_FILE: &str = "added-buckets.json";
const FILE_VERSION: u32 = 1;

pub mod msg {
    pub const EMPTY: &str = "Enter a bucket name, an s3:// address or a bucket ARN.";
    pub const NOT_FOUND: &str = "No bucket with that name exists (or it is not reachable from this connection).";

    pub fn invalid_name(name: &str) -> String {
        format!(
            "“{name}” is not a valid bucket name. Bucket names use lowercase letters, numbers, dots and hyphens, and start and end with a letter or number."
        )
    }
    pub fn invalid_arn(arn: &str) -> String {
        format!("“{arn}” is not an S3 bucket or access point ARN.")
    }
    pub fn access_denied(name: &str) -> String {
        format!(
            "The bucket “{name}” exists, but these credentials can't list it. Ask its owner to grant s3:ListBucket on it to you."
        )
    }
}

/// Longest name accepted (S3 buckets created before 2018 in us-east-1 could have up to 255
/// characters; new ones have at most 63).
const NAME_MAX: usize = 255;

/// A bucket name as typed: 3..=255 characters from `a-z A-Z 0-9 . - _`, starting and ending with
/// a letter or number. Deliberately looser than today's AWS rules (legacy names, S3-compatible
/// services), but strict enough to refuse anything that cannot be a bucket (spaces, slashes,
/// `?`, `#`, `:`...).
fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    (3..=NAME_MAX).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
        && b.first().is_some_and(u8::is_ascii_alphanumeric)
        && b.last().is_some_and(u8::is_ascii_alphanumeric)
}

fn checked(name: &str) -> AppResult<String> {
    if valid_name(name) {
        Ok(name.to_string())
    } else {
        Err(AppError::invalid(msg::invalid_name(name)))
    }
}

/// Turns what the user typed into the bucket value used for every request:
/// - a bare name (`my-bucket`; an access point alias `name-abc123-s3alias` is a name too);
/// - `s3://name`, `s3://name/`, `s3://name/any/path` (the path is ignored; scheme case-insensitive);
/// - `arn:<partition>:s3:::name` (also `arn:...:::name/key`, the key is ignored);
/// - an access point ARN `arn:<partition>:s3:<region>:<account>:accesspoint/<name>` is kept as
///   the bucket value (anything after the access point name is dropped).
///
/// Surrounding whitespace is trimmed. Anything else is `InvalidInput`.
pub fn parse_bucket_input(input: &str) -> AppResult<String> {
    let s = input.trim();
    if s.is_empty() {
        return Err(AppError::invalid(msg::EMPTY));
    }
    if s.len() >= 5 && s[..5].eq_ignore_ascii_case("s3://") {
        let rest = &s[5..];
        let name = rest.split('/').next().unwrap_or_default();
        if name.is_empty() {
            return Err(AppError::invalid(msg::EMPTY));
        }
        return checked(name);
    }
    if s.len() >= 4 && s[..4].eq_ignore_ascii_case("arn:") {
        return parse_arn(s);
    }
    checked(s)
}

fn parse_arn(arn: &str) -> AppResult<String> {
    let bad = || AppError::invalid(msg::invalid_arn(arn));
    // arn:partition:service:region:account:resource (the resource may contain ':' and '/').
    let parts: Vec<&str> = arn.splitn(6, ':').collect();
    let [_, partition, service, region, account, resource] = parts.as_slice() else { return Err(bad()) };
    if partition.is_empty() || !service.eq_ignore_ascii_case("s3") || resource.is_empty() {
        return Err(bad());
    }
    if region.is_empty() && account.is_empty() {
        // Bucket ARN: arn:aws:s3:::name or arn:aws:s3:::name/key
        let name = resource.split('/').next().unwrap_or_default();
        return checked(name);
    }
    // Access point ARN: arn:aws:s3:region:account:accesspoint/name[/...]
    let ap = resource.strip_prefix("accesspoint/").or_else(|| resource.strip_prefix("accesspoint:")).ok_or_else(bad)?;
    let ap_name = ap.split(['/', ':']).next().unwrap_or_default();
    // Access point names: 3..=50 characters, letters, numbers and hyphens.
    let ap_ok = (3..=50).contains(&ap_name.len()) && ap_name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-');
    if region.is_empty() || account.is_empty() || !ap_ok {
        return Err(bad());
    }
    let sep = &resource["accesspoint".len()..="accesspoint".len()];
    Ok(format!("arn:{partition}:{service}:{region}:{account}:accesspoint{sep}{ap_name}"))
}

/// The region in an access point ARN (`arn:aws:s3:eu-west-1:...` → `eu-west-1`).
pub fn arn_region(bucket: &str) -> Option<&str> {
    let mut parts = bucket.splitn(6, ':');
    if !parts.next()?.eq_ignore_ascii_case("arn") {
        return None;
    }
    let _partition = parts.next()?;
    let _service = parts.next()?;
    parts.next().filter(|r| !r.is_empty())
}

/// Identity of a connection for the store: a saved connection's id, otherwise
/// `profile:<name>@<endpoint or aws>` / `static:<accessKeyId>@<endpoint or aws>`.
pub fn identity_for(kind: &str, who: &str, endpoint: Option<&str>) -> String {
    format!("{kind}:{who}@{}", endpoint.unwrap_or("aws"))
}

/// Verifies that `bucket` exists and can be listed: `HeadBucket`, then one `ListObjectsV2` with
/// `max-keys=1`. Not found → `NoSuchBucket`; no permission → `AccessDenied` saying the bucket
/// exists but cannot be listed with these credentials.
pub async fn verify(client: &Client, bucket: &str) -> AppResult<()> {
    let map = |e: AppError| -> AppError {
        match e.code {
            // HeadBucket answers a missing bucket with a bare 404 ("NotFound"), which the generic
            // mapping reads as a missing key.
            ErrorCode::NoSuchBucket | ErrorCode::NoSuchKey => AppError::new(ErrorCode::NoSuchBucket, msg::NOT_FOUND),
            ErrorCode::AccessDenied => AppError::new(ErrorCode::AccessDenied, msg::access_denied(bucket)),
            _ => e,
        }
    };
    client.head_bucket().bucket(bucket).send().await.map_err(|e| map(e.into()))?;
    client.list_objects_v2().bucket(bucket).max_keys(1).send().await.map_err(|e| map(e.into()))?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileOut {
    version: u32,
    connections: BTreeMap<String, Vec<AddedBucket>>,
}

/// Reads the file. Never fails: missing/corrupt → empty; unreadable entries, empty names and
/// duplicates within one connection are skipped.
fn load_file(path: &Path) -> BTreeMap<String, Vec<AddedBucket>> {
    let mut out = BTreeMap::new();
    let Some(v) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else {
        return out;
    };
    let Some(conns) = v.get("connections").and_then(serde_json::Value::as_object) else { return out };
    for (id, list) in conns {
        let Some(list) = list.as_array() else { continue };
        let mut items: Vec<AddedBucket> = Vec::new();
        for item in list {
            let Ok(b) = serde_json::from_value::<AddedBucket>(item.clone()) else { continue };
            if b.name.trim().is_empty() || items.iter().any(|x| x.name == b.name) {
                continue;
            }
            items.push(b);
        }
        if !items.is_empty() {
            items.sort_by(|a, b| a.name.cmp(&b.name));
            out.insert(id.clone(), items);
        }
    }
    out
}

/// Added buckets per connection identity. `path: None` keeps them in memory only.
pub struct AddedBucketStore {
    path: Option<PathBuf>,
    /// Held across each read-modify-write so concurrent adds never lose an entry.
    items: tokio::sync::Mutex<BTreeMap<String, Vec<AddedBucket>>>,
}

impl AddedBucketStore {
    pub fn load(path: PathBuf) -> Self {
        let items = load_file(&path);
        Self { path: Some(path), items: tokio::sync::Mutex::new(items) }
    }

    pub fn in_memory() -> Self {
        Self { path: None, items: tokio::sync::Mutex::new(BTreeMap::new()) }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    async fn write(&self, items: BTreeMap<String, Vec<AddedBucket>>) -> AppResult<BTreeMap<String, Vec<AddedBucket>>> {
        let Some(path) = self.path.clone() else { return Ok(items) };
        tokio::task::spawn_blocking(move || {
            let out = FileOut { version: FILE_VERSION, connections: items };
            write_json_atomic(&path, &out, "added buckets").map(|()| out.connections)
        })
        .await?
    }

    /// The connection's added buckets, sorted by name.
    pub async fn list(&self, identity: &str) -> Vec<AddedBucket> {
        self.items.lock().await.get(identity).cloned().unwrap_or_default()
    }

    pub async fn find(&self, identity: &str, name: &str) -> Option<AddedBucket> {
        self.items.lock().await.get(identity).and_then(|l| l.iter().find(|b| b.name == name).cloned())
    }

    /// Stores `bucket` for `identity` (an existing entry with that name is returned unchanged).
    /// On a write failure nothing changes in memory either.
    pub async fn insert(&self, identity: &str, bucket: AddedBucket) -> AppResult<AddedBucket> {
        let mut items = self.items.lock().await;
        if let Some(existing) = items.get(identity).and_then(|l| l.iter().find(|b| b.name == bucket.name)) {
            return Ok(existing.clone());
        }
        let mut next = items.clone();
        let list = next.entry(identity.to_string()).or_default();
        list.push(bucket.clone());
        list.sort_by(|a, b| a.name.cmp(&b.name));
        *items = self.write(next).await?;
        Ok(bucket)
    }

    /// Forgets `name` for `identity`. Unknown name is a no-op. Never touches S3.
    pub async fn remove(&self, identity: &str, name: &str) -> AppResult<()> {
        let mut items = self.items.lock().await;
        if !items.get(identity).is_some_and(|l| l.iter().any(|b| b.name == name)) {
            return Ok(());
        }
        let mut next = items.clone();
        if let Some(list) = next.get_mut(identity) {
            list.retain(|b| b.name != name);
            if list.is_empty() {
                next.remove(identity);
            }
        }
        *items = self.write(next).await?;
        Ok(())
    }
}

/// `add_bucket`: parse, return an existing entry as is, otherwise verify and store.
/// `client` must already be the bucket's regional client; `region` is what was resolved for it
/// (`None` with a custom endpoint).
pub async fn add(
    store: &AddedBucketStore,
    identity: &str,
    name: &str,
    client: &Client,
    region: Option<String>,
) -> AppResult<AddedBucket> {
    if let Some(existing) = store.find(identity, name).await {
        return Ok(existing);
    }
    verify(client, name).await?;
    store.insert(identity, AddedBucket { name: name.to_string(), region, added_at: now_iso() }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{h, FakeS3, Reply};

    fn ok(input: &str) -> String {
        parse_bucket_input(input).unwrap_or_else(|e| panic!("{input:?}: {}", e.message))
    }
    fn bad(input: &str) -> String {
        let e = parse_bucket_input(input).expect_err(input);
        assert_eq!(e.code, ErrorCode::InvalidInput, "{input:?}");
        e.message
    }

    #[test]
    fn bare_names() {
        assert_eq!(ok("my-bucket"), "my-bucket");
        assert_eq!(ok("  my.bucket.example  "), "my.bucket.example");
        assert_eq!(ok("\tabc\n"), "abc");
        assert_eq!(ok("Legacy_Bucket"), "Legacy_Bucket");
        assert_eq!(ok("my-ap-hrzrlukc5m36ft7okagglf3gmwluquse1b-s3alias"), "my-ap-hrzrlukc5m36ft7okagglf3gmwluquse1b-s3alias");
        assert_eq!(ok("my-olap--ol-s3"), "my-olap--ol-s3");
    }

    #[test]
    fn s3_uris() {
        assert_eq!(ok("s3://name"), "name");
        assert_eq!(ok("s3://name/"), "name");
        assert_eq!(ok("s3://name/any/path/file.txt"), "name");
        assert_eq!(ok("S3://Name.With.Dots/x"), "Name.With.Dots");
        assert_eq!(ok("  s3://abc  "), "abc");
        assert!(bad("s3://").contains("Enter a bucket name"));
        assert!(bad("s3:///path").contains("Enter a bucket name"));
        assert!(bad("s3://a b/c").contains("not a valid bucket name"));
    }

    #[test]
    fn bucket_arns() {
        assert_eq!(ok("arn:aws:s3:::name"), "name");
        assert_eq!(ok("arn:aws:s3:::name/some/key"), "name");
        assert_eq!(ok("arn:aws-cn:s3:::cn-bucket"), "cn-bucket");
        assert_eq!(ok("arn:aws-us-gov:s3:::gov-bucket/*"), "gov-bucket");
        assert!(bad("arn:aws:s3:::").contains("not an S3"));
        assert!(bad("arn:aws:ec2:::name").contains("not an S3"));
        assert!(bad("arn:aws:s3").contains("not an S3"));
        assert!(bad("arn:aws:s3:::a?b").contains("not a valid bucket name"));
    }

    #[test]
    fn access_point_arns_pass_through() {
        let ap = "arn:aws:s3:us-west-2:123456789012:accesspoint/my-ap";
        assert_eq!(ok(ap), ap);
        assert_eq!(ok(&format!("  {ap}  ")), ap);
        assert_eq!(ok(&format!("{ap}/object/some/key")), ap);
        assert_eq!(ok("arn:aws:s3:us-west-2:123456789012:accesspoint:my-ap"), "arn:aws:s3:us-west-2:123456789012:accesspoint:my-ap");
        assert!(bad("arn:aws:s3:us-west-2::accesspoint/my-ap").contains("not an S3"));
        assert!(bad("arn:aws:s3:us-west-2:123456789012:bucket/x").contains("not an S3"));
        assert!(bad("arn:aws:s3:us-west-2:123456789012:accesspoint/").contains("not an S3"));
        assert!(bad("arn:aws:s3:us-west-2:123456789012:accesspoint/a_b").contains("not an S3"));
        assert_eq!(arn_region(ap), Some("us-west-2"));
        assert_eq!(arn_region("my-bucket"), None);
        assert_eq!(arn_region("arn:aws:s3:::name"), None);
    }

    #[test]
    fn rejects_obviously_invalid_input() {
        for s in ["", "   ", "\t\n"] {
            assert!(bad(s).contains("Enter a bucket name"), "{s:?}");
        }
        for s in ["ab", "a b", "bucket/path", "-bucket", "bucket-", ".bucket", "bucket.", "a?b", "a#b", "ä-bucket", "http://x.y", "a:b", &"x".repeat(256)] {
            assert!(bad(s).contains("not a valid bucket name"), "{s:?}");
        }
    }

    #[test]
    fn identities() {
        assert_eq!(identity_for("profile", "dev", None), "profile:dev@aws");
        assert_eq!(identity_for("static", "AKIA123", Some("http://127.0.0.1:8333")), "static:AKIA123@http://127.0.0.1:8333");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-scratch")
            .join(format!("added-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    fn ab(name: &str) -> AddedBucket {
        AddedBucket { name: name.into(), region: Some("eu-west-1".into()), added_at: "2026-10-06T00:00:00.000Z".into() }
    }

    #[tokio::test]
    async fn store_round_trip_and_identity_separation() {
        let dir = temp_dir("store");
        let path = dir.join(ADDED_BUCKETS_FILE);
        let s = AddedBucketStore::load(path.clone());
        assert!(s.list("c1").await.is_empty());
        s.insert("c1", ab("zeta")).await.expect("insert");
        s.insert("c1", ab("alpha")).await.expect("insert");
        s.insert("c2", ab("other")).await.expect("insert");
        // existing entry returned unchanged
        let again = s.insert("c1", AddedBucket { region: None, ..ab("zeta") }).await.expect("insert");
        assert_eq!(again.region.as_deref(), Some("eu-west-1"));
        let names = |l: Vec<AddedBucket>| l.into_iter().map(|b| b.name).collect::<Vec<_>>();
        assert_eq!(names(s.list("c1").await), ["alpha", "zeta"]);
        assert_eq!(names(s.list("c2").await), ["other"]);
        // reload from disk
        let s2 = AddedBucketStore::load(path.clone());
        assert_eq!(names(s2.list("c1").await), ["alpha", "zeta"]);
        assert_eq!(s2.list("c1").await, s.list("c1").await);
        s2.remove("c1", "zeta").await.expect("remove");
        s2.remove("c1", "unknown").await.expect("no-op");
        s2.remove("nobody", "x").await.expect("no-op");
        let s3 = AddedBucketStore::load(path.clone());
        assert_eq!(names(s3.list("c1").await), ["alpha"]);
        assert_eq!(names(s3.list("c2").await), ["other"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lenient_load() {
        let dir = temp_dir("lenient");
        let path = dir.join(ADDED_BUCKETS_FILE);
        std::fs::write(&path, b"not json").expect("write");
        assert!(load_file(&path).is_empty());
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 1,
                "connections": {
                    "a": [
                        {"name": "b2", "region": null, "addedAt": "t"},
                        {"name": "b1", "region": "us-east-1", "addedAt": "t"},
                        {"name": 5},
                        {"name": "", "region": null, "addedAt": "t"},
                        {"name": "b1", "region": null, "addedAt": "dup"}
                    ],
                    "b": "not a list",
                    "c": []
                }
            })
            .to_string(),
        )
        .expect("write");
        let m = load_file(&path);
        assert_eq!(m.len(), 1);
        let a = &m["a"];
        assert_eq!(a.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["b1", "b2"]);
        assert_eq!(a[0].region.as_deref(), Some("us-east-1"));
        assert!(load_file(&dir.join("missing.json")).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn write_failure_changes_nothing() {
        let dir = temp_dir("fail");
        // The "file" path is a directory: the atomic rename fails.
        let path = dir.join("as-dir");
        std::fs::create_dir_all(path.join("x")).expect("mkdir");
        let s = AddedBucketStore::load(path);
        assert!(s.insert("c", ab("x1")).await.is_err());
        assert!(s.list("c").await.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn verify_maps_errors() {
        // HeadBucket 404 without a code → NoSuchBucket (not NoSuchKey)
        let fake = FakeS3::start(|r| if r.method == "HEAD" { Reply::status(404) } else { Reply::status(200) }).await;
        let e = verify(&fake.client(), "nope").await.expect_err("missing");
        assert_eq!(e.code, ErrorCode::NoSuchBucket);
        // HeadBucket 403 → AccessDenied with the "exists but can't list" message
        let fake = FakeS3::start(|_| Reply::status(403)).await;
        let e = verify(&fake.client(), "shared").await.expect_err("denied");
        assert_eq!(e.code, ErrorCode::AccessDenied);
        assert!(e.message.contains("exists") && e.message.contains("“shared”"), "{}", e.message);
        // HeadBucket allowed, ListObjectsV2 denied → same AccessDenied
        let fake = FakeS3::start(|r| {
            if r.method == "HEAD" {
                Reply::with_headers(200, vec![h("x-amz-bucket-region", "us-east-1")])
            } else {
                Reply::xml(403, "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>")
            }
        })
        .await;
        let e = verify(&fake.client(), "half").await.expect_err("denied");
        assert_eq!(e.code, ErrorCode::AccessDenied);
        assert!(e.message.contains("can't list"), "{}", e.message);
        // Both fine
        let fake = FakeS3::start(|r| {
            if r.method == "HEAD" {
                Reply::status(200)
            } else {
                Reply::xml(200, r#"<ListBucketResult><Name>b</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>"#)
            }
        })
        .await;
        verify(&fake.client(), "fine").await.expect("ok");
        assert_eq!(fake.count(|r| r.has_query("max-keys") && r.query.contains("max-keys=1")), 1);
    }
}
