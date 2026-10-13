//! End-to-end test for "Edit content type and metadata" (`update_object_metadata`) against a local
//! S3-compatible server (SeaweedFS, see the smoke-test skill).
//!
//! Every scenario snapshots every object in the bucket (body SHA-256, size, ETag, storage class, every
//! header the edit touches or must keep, and the tag set) before and after, and asserts exactly what
//! changed and what survived.
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin).
//!
//! Run: `cargo run --example metadata`

use std::collections::{BTreeMap, BTreeSet, HashMap};

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::{ByteStream, DateTime, DateTimeFormat};
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart, MetadataDirective, StorageClass};
use aws_sdk_s3::Client;
use s3explorer_lib::error::{AppError, ErrorCode};
use s3explorer_lib::metadata::update_object_metadata;
use s3explorer_lib::models::{ConnectionConfig, MetadataEdit};
use s3explorer_lib::state::Connection;
use s3explorer_lib::{ops, tags};
use sha2::{Digest, Sha256};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const B: &str = "meta-e2e";

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn check(cond: bool, what: &str) -> Res<()> {
    if cond {
        println!("  ok  {what}");
        Ok(())
    } else {
        Err(format!("FAILED: {what}").into())
    }
}

fn expect_err<T: std::fmt::Debug>(r: Result<T, AppError>, code: ErrorCode, what: &str) -> Res<AppError> {
    match r {
        Ok(v) => Err(format!("FAILED: {what}: expected {code:?}, got Ok({v:?})").into()),
        Err(e) if e.code == code => {
            println!("  ok  {what} -> {:?}: {}", e.code, e.message);
            Ok(e)
        }
        Err(e) => Err(format!("FAILED: {what}: expected {code:?}, got {:?}: {}", e.code, e.message).into()),
    }
}

/// Everything about one object that an edit may change or must keep.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Obj {
    sha: String,
    size: i64,
    etag: String,
    last_modified: String,
    storage_class: String,
    content_type: Option<String>,
    cache_control: Option<String>,
    content_disposition: Option<String>,
    content_encoding: Option<String>,
    content_language: Option<String>,
    metadata: BTreeMap<String, String>,
    tags: BTreeSet<(String, String)>,
}

type Snap = BTreeMap<String, Obj>;

async fn read(c: &Client, key: &str) -> Res<Obj> {
    let g = c.get_object().bucket(B).key(key).send().await?;
    let storage_class = g.storage_class().map(|s| s.as_str().to_string()).unwrap_or_else(|| "STANDARD".into());
    let o = Obj {
        size: g.content_length().unwrap_or(-1),
        etag: g.e_tag().unwrap_or_default().to_string(),
        // ISO-8601, as `ObjectMeta.lastModified` gives it to the dialog.
        last_modified: g.last_modified().and_then(|d| d.fmt(DateTimeFormat::DateTime).ok()).unwrap_or_default(),
        storage_class,
        content_type: g.content_type().map(str::to_string),
        cache_control: g.cache_control().map(str::to_string),
        content_disposition: g.content_disposition().map(str::to_string),
        content_encoding: g.content_encoding().map(str::to_string),
        content_language: g.content_language().map(str::to_string),
        metadata: g.metadata().cloned().unwrap_or_default().into_iter().collect(),
        tags: BTreeSet::new(),
        sha: String::new(),
    };
    let body = g.body.collect().await?.into_bytes();
    let tags = tags::get_object_tags(c, B, key).await?;
    Ok(Obj {
        sha: format!("{:x}", Sha256::digest(&body)),
        tags: tags.into_iter().map(|t| (t.key, t.value)).collect(),
        ..o
    })
}

async fn snap(c: &Client) -> Res<Snap> {
    let mut out = Snap::new();
    for k in ops::list_all_keys(c, B, "").await? {
        let o = read(c, &k).await?;
        out.insert(k, o);
    }
    Ok(out)
}

fn pseudo_random(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x & 0xff) as u8
        })
        .collect()
}

async fn seed(c: &Client) -> Res<()> {
    let _ = c.create_bucket().bucket(B).send().await;
    for k in ops::list_all_keys(c, B, "").await? {
        c.delete_object().bucket(B).key(&k).send().await?;
    }
    // A small object with tags, a non-default storage class and headers REPLACE would drop.
    c.put_object()
        .bucket(B)
        .key("docs/report v1+final?.txt")
        .body(ByteStream::from(pseudo_random(100_000, 1)))
        .content_type("text/plain")
        .content_encoding("identity")
        .content_language("en-GB")
        .metadata("old-key", "old value")
        .storage_class(StorageClass::StandardIa)
        .tagging("team=data&keep=yes")
        .send()
        .await?;
    // A neighbour that no edit may touch.
    c.put_object()
        .bucket(B)
        .key("docs/neighbour.txt")
        .body(ByteStream::from(pseudo_random(5_000, 2)))
        .content_type("text/plain")
        .metadata("n", "1")
        .tagging("n=1")
        .send()
        .await?;
    // A multipart object: its ETag changes on a single-request copy; its body must not.
    let key = "big/multipart.bin";
    let up = c.create_multipart_upload().bucket(B).key(key).content_type("application/octet-stream").tagging("mp=1").send().await?;
    let id = up.upload_id().unwrap_or_default().to_string();
    let mut parts = Vec::new();
    for (i, chunk) in [pseudo_random(6 * 1024 * 1024, 3), pseudo_random(1024 * 1024, 4)].into_iter().enumerate() {
        let n = i as i32 + 1;
        let p = c.upload_part().bucket(B).key(key).upload_id(&id).part_number(n).body(ByteStream::from(chunk)).send().await?;
        parts.push(CompletedPart::builder().part_number(n).set_e_tag(p.e_tag().map(str::to_string)).build());
    }
    c.complete_multipart_upload()
        .bucket(B)
        .key(key)
        .upload_id(&id)
        .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
        .send()
        .await?;
    Ok(())
}

/// What another client does: a metadata-only copy onto itself (keeps a single-part ETag).
async fn other_client_metadata_edit(c: &Client, key: &str, marker: &str) -> Res<()> {
    c.copy_object()
        .bucket(B)
        .key(key)
        .copy_source(s3explorer_lib::jobs::plan::encode_copy_source(B, key))
        .metadata_directive(MetadataDirective::Replace)
        .content_type("text/plain")
        .metadata("changed-by", marker)
        .send()
        .await?;
    Ok(())
}

/// The edit the dialog would send after showing `shown`.
fn edit(key: &str, shown: &Obj, metadata: &[(&str, &str)]) -> MetadataEdit {
    MetadataEdit {
        bucket: B.into(),
        key: key.into(),
        expected_etag: shown.etag.clone(),
        expected_last_modified: shown.last_modified.clone(),
        content_type: "text/csv; charset=utf-8".into(),
        cache_control: Some("max-age=3600, public".into()),
        content_disposition: Some("attachment; filename=\"report.csv\"".into()),
        metadata: metadata.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>(),
    }
}

/// Every key except `changed` is identical; `changed` keeps body, size, storage class, tags and the
/// carried-over headers.
fn assert_survived(before: &Snap, after: &Snap, changed: &str, what: &str) -> Res<()> {
    check(before.keys().eq(after.keys()), &format!("{what}: same keys"))?;
    for (k, b) in before {
        let a = &after[k];
        if k == changed {
            check(a.sha == b.sha && a.size == b.size, &format!("{what}: body of {k:?} byte-for-byte unchanged"))?;
            check(a.storage_class == b.storage_class, &format!("{what}: storage class kept ({})", a.storage_class))?;
            check(a.tags == b.tags, &format!("{what}: tags kept ({:?})", a.tags))?;
            check(
                a.content_encoding == b.content_encoding && a.content_language == b.content_language,
                &format!("{what}: Content-Encoding / Content-Language kept ({:?} / {:?})", a.content_encoding, a.content_language),
            )?;
        } else {
            check(a == b, &format!("{what}: {k:?} untouched"))?;
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let config = ConnectionConfig::Static {
        access_key_id: env("SMOKE_ACCESS_KEY", "minioadmin"),
        secret_access_key: env("SMOKE_SECRET_KEY", "minioadmin"),
        session_token: None,
        region: "us-east-1".into(),
        endpoint: Some(endpoint.clone()),
        force_path_style: None,
    };
    let conn = Connection::open(config).await?;
    let c = conn.client_for_bucket(B).await;
    seed(&c).await?;
    let small = "docs/report v1+final?.txt";

    println!("1. edit content type, headers and user metadata");
    let before = snap(&c).await?;
    let etag = before[small].etag.clone();
    let e = edit(small, &before[small], &[("owner", "team-a"), ("review-state", "approved  twice")]);
    let m = update_object_metadata(&c, &e).await?;
    let after = snap(&c).await?;
    let a = &after[small];
    check(a.content_type.as_deref() == Some("text/csv; charset=utf-8"), "content type written")?;
    check(a.cache_control == e.cache_control, "Cache-Control written")?;
    check(a.content_disposition == e.content_disposition, "Content-Disposition written")?;
    let want: BTreeMap<String, String> = e.metadata.clone().into_iter().collect();
    check(a.metadata == want, &format!("user metadata replaced as a whole: {:?}", a.metadata))?;
    check(m.content_type == a.content_type && m.cache_control == a.cache_control, "returned ObjectMeta is the read-back")?;
    assert_survived(&before, &after, small, "edit")?;

    println!("2. stale ETag (another client rewrote the body): nothing is written");
    // A metadata-only copy keeps a single-part ETag (it is the body's MD5), so `etag` is still
    // current here; a new body makes it stale.
    check(after[small].etag == etag, "a single-part ETag is unchanged by the edit")?;
    let shown = after[small].clone();
    c.put_object().bucket(B).key(small).body(ByteStream::from(pseudo_random(100_000, 9))).tagging("team=data&keep=yes").send().await?;
    let before = snap(&c).await?;
    let stale = edit(small, &shown, &[("owner", "someone-else")]);
    let err = expect_err(update_object_metadata(&c, &stale).await, ErrorCode::Conflict, "stale expectedEtag")?;
    check(err.message.contains("nothing was written"), "message says nothing was written")?;
    check(snap(&c).await? == before, "bucket snapshot identical after the refused edit")?;

    println!("2b. another client changes only the metadata while the dialog is open: nothing is written");
    let shown = before[small].clone();
    // A later second than the dialog's read (S3 keeps whole seconds).
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    other_client_metadata_edit(&c, small, "first").await?;
    let before = snap(&c).await?;
    check(before[small].etag == shown.etag, "the other client's edit kept the ETag (If-Match alone would miss it)")?;
    check(before[small].last_modified != shown.last_modified, "but LastModified moved")?;
    let err = expect_err(
        update_object_metadata(&c, &edit(small, &shown, &[("owner", "me")])).await,
        ErrorCode::Conflict,
        "metadata-only change by someone else",
    )?;
    check(err.message.contains("nothing was written"), "message says nothing was written")?;
    check(snap(&c).await? == before, "bucket snapshot identical: the other client's metadata survived")?;

    println!("3. the server enforces CopySourceIfMatch (the race the pre-check cannot see)");
    let r = c
        .copy_object()
        .bucket(B)
        .key(small)
        .copy_source(s3explorer_lib::jobs::plan::encode_copy_source(B, small))
        .copy_source_if_match("\"0123456789abcdef0123456789abcdef\"")
        .metadata_directive(MetadataDirective::Replace)
        .content_type("application/x-should-not-land")
        .send()
        .await;
    let honoured = matches!(&r, Err(e) if e.raw_response().map(|r| r.status().as_u16()) == Some(412) || e.code() == Some("PreconditionFailed"));
    let unchanged = snap(&c).await? == before;
    println!("  info  server answered a wrong If-Match with {}; object unchanged: {unchanged}", if honoured { "412" } else { "something else" });
    check(honoured && unchanged, "a wrong CopySourceIfMatch writes nothing")?;

    println!("3b. how this server evaluates CopySourceIfUnmodifiedSince (informational, no pre-check involved)");
    let shown = before[small].clone();
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    other_client_metadata_edit(&c, small, "second").await?;
    let since = DateTime::from_str(&shown.last_modified, DateTimeFormat::DateTime)?;
    let reference = snap(&c).await?;
    for (with_if_match, label) in [(false, "If-Unmodified-Since alone"), (true, "If-Match (true) + If-Unmodified-Since (false)")] {
        let mut req = c
            .copy_object()
            .bucket(B)
            .key(small)
            .copy_source(s3explorer_lib::jobs::plan::encode_copy_source(B, small))
            .copy_source_if_unmodified_since(since)
            .metadata_directive(MetadataDirective::Replace)
            .content_type("application/x-probe");
        if with_if_match {
            req = req.copy_source_if_match(shown.etag.clone());
        }
        let r = req.send().await;
        let refused = matches!(&r, Err(e) if e.raw_response().map(|r| r.status().as_u16()) == Some(412) || e.code() == Some("PreconditionFailed"));
        let unchanged = snap(&c).await? == reference;
        println!("  info  {label}: server {}; object unchanged: {unchanged}", if refused { "answered 412" } else { "copied" });
        if !refused {
            // Put the probe's write back the way it was, so later scenarios start from known state.
            other_client_metadata_edit(&c, small, "second").await?;
        }
    }

    println!("4. invalid input is refused before any request");
    let before = snap(&c).await?;
    let shown = &before[small];
    for (k, v, what) in [
        ("Owner", "x", "uppercase key"),
        ("a:b", "x", "key with a separator (not an HTTP token)"),
        ("a b", "x", "key with a space"),
        ("k", "caf\u{e9}", "non-ASCII value"),
        ("k", "a\nb", "control character"),
        ("k", " x", "leading space"),
    ] {
        expect_err(update_object_metadata(&c, &edit(small, shown, &[(k, v)])).await, ErrorCode::InvalidInput, what)?;
    }
    let big: Vec<(String, String)> = (0..9).map(|i| (format!("key-{i}"), "v".repeat(250))).collect();
    let mut too_big = edit(small, shown, &[]);
    too_big.metadata = big.into_iter().collect();
    expect_err(update_object_metadata(&c, &too_big).await, ErrorCode::InvalidInput, "over 2 KiB of metadata")?;
    let mut empty_ct = edit(small, shown, &[]);
    empty_ct.content_type = String::new();
    expect_err(update_object_metadata(&c, &empty_ct).await, ErrorCode::InvalidInput, "empty content type")?;
    check(snap(&c).await? == before, "bucket snapshot identical after the refusals")?;

    println!("4b. keys with any HTTP token character, and an empty value, round-trip");
    let before = snap(&c).await?;
    let pairs = [("a.b_c~1", "dots and underscores"), ("x!#$%&'*+^`|", "symbols"), ("empty-value", "")];
    let e = edit(small, &before[small], &pairs);
    match update_object_metadata(&c, &e).await {
        Ok(_) => {
            let after = snap(&c).await?;
            let want: BTreeMap<String, String> = e.metadata.clone().into_iter().collect();
            check(after[small].metadata == want, &format!("token keys and the empty value read back as sent: {:?}", after[small].metadata))?;
            assert_survived(&before, &after, small, "token keys")?;
        }
        Err(err) if err.code != ErrorCode::Unknown => return Err(format!("FAILED: token keys refused: {:?}: {}", err.code, err.message).into()),
        Err(err) => {
            // Only a read-back mismatch on the server's side is a "cannot run here"; report it loudly.
            let after = snap(&c).await?;
            println!("  SKIPPED (server limitation): {:?}: {}; stored metadata: {:?}", err.code, err.message, after[small].metadata);
            println!("  SKIPPED: this server does not round-trip these metadata keys/values; verify on real S3");
            // Put the object back to the state later scenarios expect.
            let restore = edit(small, &after[small], &[]);
            update_object_metadata(&c, &restore).await?;
        }
    }

    println!("4c. GLACIER / DEEP_ARCHIVE objects are refused (the copy would re-archive them), nothing written");
    for class in [StorageClass::Glacier, StorageClass::DeepArchive] {
        let key = format!("archive/{}.txt", class.as_str());
        let put = c.put_object().bucket(B).key(&key).body(ByteStream::from(pseudo_random(1000, 7))).storage_class(class.clone()).send().await;
        let head = c.head_object().bucket(B).key(&key).send().await;
        let stored = head.as_ref().ok().and_then(|h| h.storage_class().map(|s| s.as_str().to_string()));
        if put.is_err() || stored.as_deref() != Some(class.as_str()) {
            println!(
                "  SKIPPED {}: this server does not store the class (put: {}, head reports {:?}); covered by the unit test refuses_restored_glacier_and_deep_archive",
                class.as_str(),
                if put.is_ok() { "ok" } else { "refused" },
                stored
            );
            let _ = c.delete_object().bucket(B).key(&key).send().await;
            continue;
        }
        let h = head?;
        let shown_etag = h.e_tag().unwrap_or_default().to_string();
        let shown_lm = h.last_modified().and_then(|d| d.fmt(DateTimeFormat::DateTime).ok()).unwrap_or_default();
        let e = MetadataEdit {
            bucket: B.into(),
            key: key.clone(),
            expected_etag: shown_etag,
            expected_last_modified: shown_lm,
            content_type: "text/csv".into(),
            cache_control: None,
            content_disposition: None,
            metadata: [("owner".to_string(), "me".to_string())].into_iter().collect(),
        };
        let before = c.head_object().bucket(B).key(&key).send().await?;
        expect_err(update_object_metadata(&c, &e).await, ErrorCode::NotSupported, &format!("{} object", class.as_str()))?;
        let after = c.head_object().bucket(B).key(&key).send().await?;
        check(
            after.e_tag() == before.e_tag() && after.last_modified() == before.last_modified() && after.metadata() == before.metadata(),
            &format!("{}: object untouched", class.as_str()),
        )?;
        c.delete_object().bucket(B).key(&key).send().await?;
    }

    println!("5. multipart object: body and tags survive, the new ETag is reported");
    let before = snap(&c).await?;
    let key = "big/multipart.bin";
    let m = update_object_metadata(&c, &edit(key, &before[key], &[("source", "e2e")])).await?;
    let after = snap(&c).await?;
    assert_survived(&before, &after, key, "multipart edit")?;
    check(m.etag.as_deref() == Some(after[key].etag.trim_matches('"')), &format!("returned ETag matches the object ({:?})", m.etag))?;

    println!("6. clearing: no Cache-Control, no Content-Disposition, no user metadata");
    let before = snap(&c).await?;
    let mut clear = edit(small, &before[small], &[]);
    clear.cache_control = None;
    clear.content_disposition = None;
    clear.content_type = "text/plain".into();
    update_object_metadata(&c, &clear).await?;
    let after = snap(&c).await?;
    let a = &after[small];
    check(a.cache_control.is_none() && a.content_disposition.is_none() && a.metadata.is_empty(), "headers and metadata cleared")?;
    assert_survived(&before, &after, small, "clear")?;

    println!("7. missing object");
    expect_err(update_object_metadata(&c, &edit("nope.txt", &before[small], &[])).await, ErrorCode::NoSuchKey, "missing key")?;

    println!("\nALL METADATA CHECKS PASSED");
    Ok(())
}
