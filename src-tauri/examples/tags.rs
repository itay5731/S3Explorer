//! End-to-end tests for v0.4.0's buckets added by name and tags (bucket, object, bulk tag jobs)
//! against a local S3-compatible server (SeaweedFS, see the smoke-test skill).
//!
//! Every bulk scenario snapshots every object's ETag and tag set before and after and asserts
//! exactly what changed and what stayed untouched.
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin), TAGS_LIMITED_KEY / TAGS_LIMITED_SECRET (an identity that may
//! not list `tags-shared`; default limitedkey/limitedsecret; the AccessDenied scenario is skipped
//! when that identity cannot connect), TAGS_DIR (scratch dir for the store file, default
//! target/tags-e2e), TAGS_BULK (objects in the bulk folder, default 2000).
//!
//! Run: `cargo run --example tags`

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use futures::future::FutureExt;
use futures::stream::{self, StreamExt};
use s3explorer_lib::buckets::{self, AddedBucketStore, ADDED_BUCKETS_FILE};
use s3explorer_lib::error::{AppError, ErrorCode};
use s3explorer_lib::jobs::{self, AfterListingHook, JobManager, JobSink, JobTuning};
use s3explorer_lib::models::{
    ConflictPolicy, ConnectionConfig, Job, JobItem, JobKind, JobPhase, JobRequest, JobStatus, Tag, TagMode,
    TagOperation,
};
use s3explorer_lib::state::Connection;
use s3explorer_lib::{ops, tags};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const A: &str = "tags-a";
const SHARED: &str = "tags-shared";

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

fn t(k: &str, v: &str) -> Tag {
    Tag::new(k, v)
}

fn set_of(tags: &[Tag]) -> BTreeSet<(String, String)> {
    tags.iter().map(|t| (t.key.clone(), t.value.clone())).collect()
}

fn static_config(endpoint: &str, ak: &str, sk: &str) -> ConnectionConfig {
    ConnectionConfig::Static {
        access_key_id: ak.into(),
        secret_access_key: sk.into(),
        session_token: None,
        region: "us-east-1".into(),
        endpoint: Some(endpoint.into()),
        force_path_style: None,
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

struct Recorder(Mutex<Vec<Job>>);
impl JobSink for Recorder {
    fn emit(&self, job: &Job) {
        if let Ok(mut v) = self.0.lock() {
            v.push(job.clone());
        }
    }
}
impl Recorder {
    fn events(&self, id: &str) -> Vec<Job> {
        self.0.lock().map(|v| v.iter().filter(|j| j.id == id).cloned().collect()).unwrap_or_default()
    }
}

/// Event and counter invariants every finished job must satisfy.
fn check_job(rec: &Recorder, j: &Job) -> Res<()> {
    let ev = rec.events(&j.id);
    let first_ok = ev.first().is_some_and(|e| e.status == JobStatus::Queued && e.phase == JobPhase::Listing);
    let last_ok = ev.last().is_some_and(|e| e.finished_at.is_some() && e.phase == JobPhase::Done);
    let finals = ev.iter().filter(|e| e.finished_at.is_some()).count();
    let monotonic = ev.windows(2).all(|w| w[0].done_items <= w[1].done_items && w[0].failed_items <= w[1].failed_items);
    if !(first_ok && last_ok && finals == 1 && monotonic) {
        return Err(format!("event invariants broken for {}: {first_ok} {last_ok} {finals} {monotonic}", j.label).into());
    }
    if j.status != JobStatus::Cancelled && j.error.is_none() && j.done_items + j.skipped_items + j.failed_items != j.total_items {
        return Err(format!("counters do not add up: {j:?}").into());
    }
    if j.total_bytes != 0 || j.done_bytes != 0 {
        return Err(format!("a tag job must report no bytes: {j:?}").into());
    }
    Ok(())
}

type TagSet = BTreeSet<(String, String)>;
/// key -> (ETag, tag set)
type Snap = BTreeMap<String, (String, TagSet)>;
type SnapEntry = Result<(String, (String, TagSet)), String>;

async fn snap(c: &Client, bucket: &str) -> Res<Snap> {
    let keys = ops::list_all_keys(c, bucket, "").await?;
    let results: Vec<SnapEntry> = stream::iter(keys)
        .map(|k| {
            let c = c.clone();
            async move {
                let h = c.head_object().bucket(bucket).key(&k).send().await.map_err(|e| format!("{k}: {e:?}"))?;
                let tg = tags::get_object_tags(&c, bucket, &k).await.map_err(|e| format!("{k}: {}", e.message))?;
                Ok((k, (h.e_tag().unwrap_or_default().to_string(), set_of(&tg))))
            }
        })
        .buffer_unordered(32)
        .collect()
        .await;
    let mut out = Snap::new();
    for r in results {
        let (k, v) = r?;
        out.insert(k, v);
    }
    Ok(out)
}

async fn wipe(c: &Client, bucket: &str) -> Res<()> {
    let keys = ops::list_all_keys(c, bucket, "").await?;
    let results: Vec<_> = stream::iter(keys)
        .map(|k| {
            let c = c.clone();
            async move { c.delete_object().bucket(bucket).key(k).send().await }
        })
        .buffer_unordered(32)
        .collect()
        .await;
    for r in results {
        r?;
    }
    Ok(())
}

/// Puts `key` with `tags` (an empty set: no tags).
async fn put_tagged(c: &Client, bucket: &str, key: &str, tg: &[Tag]) -> Res<()> {
    c.put_object().bucket(bucket).key(key).body(ByteStream::from(format!("body of {key}").into_bytes())).send().await?;
    if !tg.is_empty() {
        tags::put_object_tags(c, bucket, key, tg, &[]).await?;
    }
    Ok(())
}

fn tag_req(items: Vec<JobItem>, op: TagOperation) -> JobRequest {
    JobRequest {
        kind: JobKind::Tag,
        src_bucket: A.into(),
        dest_bucket: None,
        items,
        on_conflict: ConflictPolicy::Skip,
        tags: Some(op),
        restore: None,
    }
}

fn pre(p: &str) -> JobItem {
    JobItem { from: p.into(), to: None, is_prefix: true }
}
fn obj(k: &str) -> JobItem {
    JobItem { from: k.into(), to: None, is_prefix: false }
}

// ---- 0. probe -------------------------------------------------------------------------------

async fn probe(c: &Client) -> Res<()> {
    println!("0. probe: what this server supports");
    let show = |what: &str, r: Result<String, (Option<u16>, Option<String>)>| match r {
        Ok(v) => println!("  probe {what}: supported ({v})"),
        Err((s, code)) => println!("  probe {what}: status={s:?} code={code:?}"),
    };
    fn info<E: ProvideErrorMetadata>(
        e: aws_sdk_s3::error::SdkError<E, aws_sdk_s3::config::http::HttpResponse>,
    ) -> (Option<u16>, Option<String>) {
        (e.raw_response().map(|r| r.status().as_u16()), e.as_service_error().and_then(|s| s.code()).map(str::to_string))
    }
    show("GetBucketTagging (no set)", c.get_bucket_tagging().bucket(A).send().await.map(|o| format!("{} tags", o.tag_set().len())).map_err(info));
    show("GetObjectTagging (missing key)", c.get_object_tagging().bucket(A).key("nope").send().await.map(|_| "ok".into()).map_err(info));
    show("HeadBucket (unknown bucket)", c.head_bucket().bucket("no-such-bucket-tags").send().await.map(|_| "ok".into()).map_err(info));
    show(
        "HeadBucket (existing)",
        c.head_bucket().bucket(A).send().await.map(|o| format!("x-amz-bucket-region={:?}", o.bucket_region())).map_err(info),
    );
    show("GetBucketLifecycleConfiguration", c.get_bucket_lifecycle_configuration().bucket(A).send().await.map(|_| "ok".into()).map_err(info));
    Ok(())
}

// ---- 1. added buckets -----------------------------------------------------------------------

async fn added_buckets(endpoint: &str, admin: &Connection, dir: &Path) -> Res<()> {
    println!("1. buckets added by name");
    let path = dir.join(ADDED_BUCKETS_FILE);
    let _ = std::fs::remove_file(&path);
    let store = AddedBucketStore::load(path.clone());
    let id = admin.identity.clone();
    check(id == format!("static:minioadmin@{endpoint}"), &format!("connection identity is {id}"))?;
    let add = |input: &'static str| {
        let store = &store;
        let id = id.clone();
        async move {
            let name = buckets::parse_bucket_input(input)?;
            if let Some(e) = store.find(&id, &name).await {
                return Ok(e);
            }
            let (client, region) = admin.resolve_bucket(&name).await;
            buckets::add(store, &id, &name, &client, region).await
        }
    };
    let b1 = add(SHARED).await?;
    check(b1.name == SHARED && b1.region.is_none(), "add by bare name (region null with a custom endpoint)")?;
    let again = add("  s3://tags-shared/some/path/x.txt ").await?;
    check(again == b1, "the same bucket by s3:// URI returns the existing entry (same addedAt)")?;
    let again = add("arn:aws:s3:::tags-shared").await?;
    check(again == b1, "the same bucket by ARN returns the existing entry")?;
    let b2 = add("arn:aws:s3:::tags-a/prefix/").await?;
    check(b2.name == A, "add a second bucket by ARN with a path")?;
    let b3 = add("s3://tags-a").await?;
    check(b3 == b2, "s3:// form of an added bucket is the existing entry")?;
    let e = expect_err(add("s3://no-such-bucket-tags/x").await, ErrorCode::NoSuchBucket, "a bucket that does not exist")?;
    check(!e.message.is_empty(), "NoSuchBucket has a message")?;
    expect_err(add("not a bucket").await, ErrorCode::InvalidInput, "obviously invalid input")?;
    expect_err(add("   ").await, ErrorCode::InvalidInput, "empty input")?;
    let names: Vec<String> = store.list(&id).await.into_iter().map(|b| b.name).collect();
    check(names == [A, SHARED], &format!("list is sorted and has only the two verified buckets: {names:?}"))?;

    // Added buckets work like listed ones: browse it through the same client path.
    let client = admin.client_for_bucket(SHARED).await;
    let page = ops::list_objects(&client, SHARED, "", None, None).await?;
    check(page.objects.iter().any(|o| o.key == "shared.txt"), "browsing the added bucket lists its objects")?;

    // Persistence across a reload of the store from disk.
    let reloaded = AddedBucketStore::load(path.clone());
    check(reloaded.list(&id).await == store.list(&id).await, "the list survives reloading the file")?;
    let raw = std::fs::read_to_string(&path)?;
    check(raw.contains(&id) && raw.contains("\"addedAt\""), "the file is keyed by connection identity (camelCase fields)")?;

    // A second connection (different credentials) has its own, separate list.
    let limited_key = env("TAGS_LIMITED_KEY", "limitedkey");
    let limited_secret = env("TAGS_LIMITED_SECRET", "limitedsecret");
    match Connection::open(static_config(endpoint, &limited_key, &limited_secret)).await {
        Ok(limited) => {
            check(limited.identity != id, &format!("the second connection has another identity ({})", limited.identity))?;
            check(reloaded.list(&limited.identity).await.is_empty(), "the second connection sees no added buckets")?;
            // The limited identity may not list `tags-shared`.
            let (client, region) = limited.resolve_bucket(SHARED).await;
            let head = client.head_bucket().bucket(SHARED).send().await;
            println!(
                "     (limited identity: HeadBucket tags-shared -> {:?})",
                head.as_ref().map(|_| 200).unwrap_or_else(|e| e.raw_response().map(|r| r.status().as_u16()).unwrap_or(0))
            );
            let r = buckets::add(&reloaded, &limited.identity, SHARED, &client, region).await;
            let e = expect_err(r, ErrorCode::AccessDenied, "adding a bucket these credentials cannot list")?;
            check(e.message.contains("exists"), "the AccessDenied message says the bucket exists")?;
            check(reloaded.list(&limited.identity).await.is_empty(), "nothing was stored after AccessDenied")?;
            let (client, region) = limited.resolve_bucket(A).await;
            let ok = buckets::add(&reloaded, &limited.identity, A, &client, region).await?;
            check(ok.name == A, "the limited identity can add the bucket it may read")?;
            check(reloaded.list(&id).await.len() == 2, "the first connection's list is unchanged")?;
            reloaded.remove(&limited.identity, A).await?;
        }
        Err(e) => println!("  skip second connection: {} ({:?})", e.message, e.code),
    }

    // Remove: local only; the bucket and its objects stay.
    reloaded.remove(&id, SHARED).await?;
    reloaded.remove(&id, "never-added").await?;
    let after = AddedBucketStore::load(path.clone());
    let names: Vec<String> = after.list(&id).await.into_iter().map(|b| b.name).collect();
    check(names == [A], "remove forgets the bucket (also after reload); unknown name is a no-op")?;
    let still = ops::list_all_keys(admin.base_client(), SHARED, "").await?;
    check(still == ["shared.txt"], "removing never touches the bucket or its contents")?;
    Ok(())
}

// ---- 2. bucket tags -------------------------------------------------------------------------

async fn bucket_tags(c: &Client) -> Res<()> {
    println!("2. bucket tags");
    let _ = c.delete_bucket_tagging().bucket(A).send().await;
    check(tags::get_bucket_tags(c, A).await?.is_empty(), "no tag set reads as []")?;
    let want = vec![t("env", "prod"), t("ünïcødé key", "çà và"), t("team/owner", "a+b=c@d.e_f:g")];
    let stored = tags::put_bucket_tags(c, A, &want, &[]).await?;
    check(set_of(&stored) == set_of(&want), "put returns the stored set")?;
    // Stale `expected`: Conflict, nothing written.
    let r = tags::put_bucket_tags(c, A, &[t("x", "1")], &[]).await;
    let e = expect_err(r, ErrorCode::Conflict, "put with a stale expected set")?;
    check(!e.message.contains("prod"), "the Conflict message contains no tag values")?;
    check(set_of(&tags::get_bucket_tags(c, A).await?) == set_of(&want), "after Conflict the tags are unchanged")?;
    // `expected` is compared as a set: another order is fine.
    let mut shuffled = want.clone();
    shuffled.reverse();
    let next = vec![t("env", "staging")];
    let stored = tags::put_bucket_tags(c, A, &next, &shuffled).await?;
    check(set_of(&stored) == set_of(&next), "expected in another order is accepted (set comparison)")?;
    // Over the limit: InvalidInput, unchanged.
    let fifty_one: Vec<Tag> = (0..51).map(|i| t(&format!("k{i}"), "v")).collect();
    let e = expect_err(tags::put_bucket_tags(c, A, &fifty_one, &next).await, ErrorCode::InvalidInput, "51 bucket tags")?;
    check(e.message.contains("50"), "the message names the limit")?;
    let fifty: Vec<Tag> = (0..50).map(|i| t(&format!("k{i}"), "v")).collect();
    let current = match tags::put_bucket_tags(c, A, &fifty, &next).await {
        Ok(stored) => {
            check(stored.len() == 50, "50 bucket tags are accepted")?;
            fifty.clone()
        }
        Err(e) => {
            // SeaweedFS applies the object limit (10) to buckets too: report it, check nothing changed.
            let max_ok = {
                let mut ok = 0;
                for n in 1..=50usize {
                    let s: Vec<Tag> = (0..n).map(|i| t(&format!("k{i}"), "v")).collect();
                    let cur = tags::get_bucket_tags(c, A).await?;
                    if tags::put_bucket_tags(c, A, &s, &cur).await.is_err() {
                        break;
                    }
                    ok = n;
                }
                ok
            };
            println!("     server refused 50 bucket tags ({:?}: {}); it accepts at most {max_ok}", e.code, e.message);
            check(e.code == ErrorCode::InvalidInput, "the server's InvalidTag maps to InvalidInput")?;
            tags::get_bucket_tags(c, A).await?
        }
    };
    // Empty set deletes the tag set.
    let stored = tags::put_bucket_tags(c, A, &[], &current).await?;
    check(stored.is_empty(), "an empty set deletes the tag set")?;
    let raw = c.get_bucket_tagging().bucket(A).send().await;
    check(
        raw.as_ref().err().and_then(|e| e.as_service_error()).and_then(|s| s.code()) == Some("NoSuchTagSet"),
        "the server has no tag set any more (DeleteBucketTagging)",
    )?;
    expect_err(tags::get_bucket_tags(c, "no-such-bucket-tags").await, ErrorCode::NoSuchBucket, "tags of a missing bucket")?;
    Ok(())
}

// ---- 3. object tags -------------------------------------------------------------------------

async fn object_tags(c: &Client) -> Res<()> {
    println!("3. object tags");
    let key = "obj/ünïcødé file.txt";
    put_tagged(c, A, key, &[]).await?;
    check(tags::get_object_tags(c, A, key).await?.is_empty(), "a new object has no tags")?;
    let want = vec![t("ключ", "значение"), t("日本", "東京"), t("café", "")];
    let stored = tags::put_object_tags(c, A, key, &want, &[]).await?;
    check(set_of(&stored) == set_of(&want), "unicode keys and an empty value are stored as given")?;
    let r = tags::put_object_tags(c, A, key, &[t("x", "1")], &[t("ключ", "значение")]).await;
    expect_err(r, ErrorCode::Conflict, "put with a stale expected set")?;
    check(set_of(&tags::get_object_tags(c, A, key).await?) == set_of(&want), "after Conflict the tags are unchanged")?;
    let eleven: Vec<Tag> = (0..11).map(|i| t(&format!("k{i}"), "v")).collect();
    let e = expect_err(tags::put_object_tags(c, A, key, &eleven, &want).await, ErrorCode::InvalidInput, "11 object tags")?;
    check(e.message.contains("10"), "the message names the limit")?;
    expect_err(
        tags::put_object_tags(c, A, key, &[t("aws:created", "1")], &want).await,
        ErrorCode::InvalidInput,
        "a reserved aws: key",
    )?;
    let ascii = tags::put_object_tags(c, A, key, &[t(&"k".repeat(128), &"v".repeat(256))], &want).await?;
    check(ascii.len() == 1 && ascii[0].key.len() == 128 && ascii[0].value.len() == 256, "128-character key and 256-character value (ASCII) are accepted")?;
    let long_key = "ж".repeat(128);
    let ok = match tags::put_object_tags(c, A, key, &[t(&long_key, &"é".repeat(256))], &ascii).await {
        Ok(ok) => {
            check(ok.len() == 1 && ok[0].key.chars().count() == 128, "128-character key and 256-character value (multi-byte) are accepted")?;
            ok
        }
        Err(e) => {
            // The backend counts characters (as the contract says); this server counts bytes.
            println!("     server refused a 128-character multi-byte key / 256-character value ({:?}: {})", e.code, e.message);
            check(e.code == ErrorCode::InvalidInput, "the server's refusal maps to InvalidInput")?;
            check(set_of(&tags::get_object_tags(c, A, key).await?) == set_of(&ascii), "and nothing changed")?;
            ascii
        }
    };
    let stored = tags::put_object_tags(c, A, key, &[], &ok).await?;
    check(stored.is_empty(), "an empty set removes the tags (DeleteObjectTagging)")?;
    expect_err(tags::get_object_tags(c, A, "obj/missing").await, ErrorCode::NoSuchKey, "tags of a missing object")?;
    expect_err(tags::put_object_tags(c, A, "obj/missing", &[t("a", "b")], &[]).await, ErrorCode::NoSuchKey, "put on a missing object")?;
    Ok(())
}

// ---- 4. bulk tag jobs -----------------------------------------------------------------------

/// Seeds `bulk/` with `n` objects: i%5==0 has 9 tags, i%5==1 has {keep, old}, i%5==2 has {new1=old},
/// the rest none. Plus objects next to the folder that no job may touch.
async fn seed_bulk(c: &Client, n: usize) -> Res<()> {
    let jobs: Vec<(String, Vec<Tag>)> = (0..n)
        .map(|i| {
            let tg = match i % 5 {
                0 => (0..9).map(|j| t(&format!("t{j}"), "x")).collect(),
                1 => vec![t("keep", "1"), t("old", "x")],
                2 => vec![t("new1", "old")],
                _ => vec![],
            };
            (format!("bulk/sub{}/k{i:05}", i % 3), tg)
        })
        .chain([
            ("bulk-sibling/x".to_string(), vec![t("old", "x")]),
            ("bulkfile".to_string(), vec![t("old", "x")]),
            ("other/y".to_string(), vec![]),
        ])
        .collect();
    let results: Vec<Res<()>> = stream::iter(jobs)
        .map(|(k, tg)| async move { put_tagged(c, A, &k, &tg).await })
        .buffer_unordered(32)
        .collect()
        .await;
    for r in results {
        r?;
    }
    Ok(())
}

fn diff_count(a: &Snap, b: &Snap, keys: impl Fn(&str) -> bool) -> usize {
    a.iter().filter(|(k, _)| keys(k)).filter(|(k, v)| b.get(*k) != Some(*v)).count()
}

async fn bulk(c: &Client, rec: &Arc<Recorder>, mgr: &Arc<JobManager>, n: usize) -> Res<()> {
    println!("4. bulk tag jobs over a folder of {n} objects");
    let t0 = Instant::now();
    seed_bulk(c, n).await?;
    println!("     seeded in {:.1}s", t0.elapsed().as_secs_f64());
    let before = snap(c, A).await?;
    let in_bulk = |k: &str| k.starts_with("bulk/");
    check(before.keys().filter(|k| in_bulk(k)).count() == n, &format!("setup: {n} objects under bulk/"))?;

    // preview counts objects; conflicts 0
    let op = TagOperation { mode: TagMode::Merge, set: vec![t("new1", "a"), t("new2", "b")], remove: vec!["old".into()] };
    let req = tag_req(vec![pre("bulk/")], op.clone());
    let p = jobs::preview(&req, c, None).await?;
    check(p.objects == n as u64 && p.conflicts == 0 && !p.truncated, &format!("preview: {} objects, {} bytes, 0 conflicts", p.objects, p.bytes))?;
    let after_preview = snap(c, A).await?;
    check(after_preview == before, "preview changed nothing")?;

    // merge
    let t1 = Instant::now();
    let id = mgr.start(req, c.clone(), None)?;
    let j = mgr.wait(&id).await.ok_or("job vanished")?;
    let secs = t1.elapsed().as_secs_f64();
    check_job(rec, &j)?;
    let after = snap(c, A).await?;
    let over: BTreeSet<String> =
        before.iter().filter(|(k, (_, tg))| in_bulk(k) && tg.len() == 9).map(|(k, _)| k.clone()).collect();
    let mut wrong = 0;
    for (k, (etag, tg)) in &before {
        let got = &after[k];
        let want: BTreeSet<(String, String)> = if in_bulk(k) && !over.contains(k) {
            let cur: Vec<Tag> = tg.iter().map(|(a, b)| t(a, b)).collect();
            set_of(&tags::merge(&cur, &op.set, &op.remove))
        } else {
            tg.clone()
        };
        if got.1 != want || &got.0 != etag {
            wrong += 1;
            if wrong < 5 {
                println!("     wrong: {k}: got {:?} want {want:?}", got.1);
            }
        }
    }
    println!(
        "     merge: {:?} total={} done={} failed={} in {secs:.2}s ({:.0} objects/s); label {:?}",
        j.status,
        j.total_items,
        j.done_items,
        j.failed_items,
        n as f64 / secs,
        j.label
    );
    check(wrong == 0, "merge: every object has exactly the expected tags; the content (ETag) of all is unchanged")?;
    check(j.status == JobStatus::Failed && j.failed_items == over.len() as u64, &format!("merge: the {} objects that would exceed 10 tags failed", over.len()))?;
    check(j.done_items == (n - over.len()) as u64, "merge: every other object counted as done")?;
    check(
        j.errors.len() == over.len().min(50) && j.errors.iter().all(|e| over.contains(&e.key) && e.message.contains("would have 11 tags; the limit is 10")),
        "merge: errors name the over-limit objects with the limit message",
    )?;
    check(over.iter().all(|k| after[k] == before[k]), "merge: over-limit objects kept their 9 tags")?;
    check(
        ["bulk-sibling/x", "bulkfile", "other/y"].iter().all(|k| after[*k] == before[*k]),
        "merge: objects outside the folder are untouched (bulk-sibling/, bulkfile, other/)",
    )?;
    check(j.label == "Tag bulk", "label names the single item")?;

    // replace
    let before = after;
    let op = TagOperation { mode: TagMode::Replace, set: vec![t("only", "1"), t("ünï", "ç")], remove: vec![] };
    let id = mgr.start(tag_req(vec![pre("bulk/sub1/"), obj("bulkfile"), obj("bulk/missing-object")], op.clone()), c.clone(), None)?;
    let j = mgr.wait(&id).await.ok_or("job vanished")?;
    check_job(rec, &j)?;
    let after = snap(c, A).await?;
    let replaced: Vec<&String> = before.keys().filter(|k| k.starts_with("bulk/sub1/") || *k == "bulkfile").collect();
    let want = set_of(&op.set);
    check(replaced.iter().all(|k| after[*k].1 == want), &format!("replace: all {} objects have exactly the new set", replaced.len()))?;
    check(diff_count(&before, &after, |k| !(k.starts_with("bulk/sub1/") || k == "bulkfile")) == 0, "replace: every other object is untouched")?;
    check(
        j.failed_items == 1 && j.errors.first().is_some_and(|e| e.key == "bulk/missing-object" && e.message.contains("does not exist")),
        "replace: a missing single object is a per-object failure",
    )?;
    check(j.label == "Tag 3 items", "label counts items")?;

    // replace with an empty set removes all tags
    let before = after;
    let id = mgr.start(tag_req(vec![pre("bulk/sub1/")], TagOperation { mode: TagMode::Replace, set: vec![], remove: vec![] }), c.clone(), None)?;
    let j = mgr.wait(&id).await.ok_or("job vanished")?;
    check_job(rec, &j)?;
    let after = snap(c, A).await?;
    check(j.status == JobStatus::Completed, "replace with []: completed")?;
    check(after.iter().filter(|(k, _)| k.starts_with("bulk/sub1/")).all(|(_, v)| v.1.is_empty()), "replace with []: no tags left under bulk/sub1/")?;
    check(diff_count(&before, &after, |k| !k.starts_with("bulk/sub1/")) == 0, "replace with []: everything else untouched")?;
    Ok(())
}

// ---- 5. cancel --------------------------------------------------------------------------------

async fn cancel(c: &Client, rec: &Arc<Recorder>, mgr: &Arc<JobManager>, n: usize) -> Res<()> {
    println!("5. cancel a tag job mid-way");
    let before = snap(c, A).await?;
    let marker = t("cancel-run", "1");
    let op = TagOperation { mode: TagMode::Replace, set: vec![marker.clone()], remove: vec![] };
    let id = mgr.start(tag_req(vec![pre("bulk/")], op), c.clone(), None)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let j = mgr.get(&id).ok_or("job vanished")?;
        if j.done_items >= (n as u64) / 10 || !j.status.is_active() || Instant::now() > deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    mgr.cancel(&id)?;
    let j = mgr.wait(&id).await.ok_or("job vanished")?;
    check_job(rec, &j)?;
    let after = snap(c, A).await?;
    let want = set_of(std::slice::from_ref(&marker));
    let changed = after.iter().filter(|(k, v)| k.starts_with("bulk/") && v.1 == want).count();
    let neither = after.iter().filter(|(k, v)| k.starts_with("bulk/") && v.1 != want && before[*k] != **v).count();
    println!("     cancelled after done={} of {} (status {:?}); objects with the new set: {changed}", j.done_items, j.total_items, j.status);
    check(j.status == JobStatus::Cancelled, "status is cancelled")?;
    check(changed > 0 && changed < n, "some but not all objects were changed")?;
    check(changed as u64 == j.done_items, "objects changed == doneItems (in-flight requests finished and were counted)")?;
    check(neither == 0, "every other object kept exactly its previous tags")?;
    check(diff_count(&before, &after, |k| !k.starts_with("bulk/")) == 0, "objects outside the folder are untouched")?;
    Ok(())
}

// ---- 6. rejections and an object that disappears ---------------------------------------------

async fn rejections(c: &Client, rec: &Arc<Recorder>) -> Res<()> {
    println!("6. requests that are refused, and an object that disappears after the listing");
    let mgr = JobManager::new(rec.clone());
    let before = snap(c, A).await?;
    let op = TagOperation { mode: TagMode::Merge, set: vec![t("x", "1")], remove: vec![] };
    let del = JobRequest {
        kind: JobKind::Delete,
        src_bucket: A.into(),
        dest_bucket: None,
        items: vec![pre("bulk/")],
        on_conflict: ConflictPolicy::Skip,
        tags: Some(op.clone()),
        restore: None,
    };
    expect_err(mgr.start(del.clone(), c.clone(), None), ErrorCode::InvalidInput, "a delete job with tags set")?;
    expect_err(jobs::preview(&del, c, None).await, ErrorCode::InvalidInput, "preview of a delete job with tags set")?;
    let copy = JobRequest { kind: JobKind::Copy, dest_bucket: Some(A.into()), items: vec![JobItem { from: "bulk/".into(), to: Some("copy/".into()), is_prefix: true }], ..del.clone() };
    expect_err(mgr.start(copy, c.clone(), Some(c.clone())), ErrorCode::InvalidInput, "a copy job with tags set")?;
    let no_tags = JobRequest { tags: None, ..tag_req(vec![pre("bulk/")], op.clone()) };
    expect_err(mgr.start(no_tags, c.clone(), None), ErrorCode::InvalidInput, "a tag job without tags")?;
    let with_dest = JobRequest { dest_bucket: Some(A.into()), ..tag_req(vec![pre("bulk/")], op.clone()) };
    expect_err(mgr.start(with_dest, c.clone(), None), ErrorCode::InvalidInput, "a tag job with destBucket")?;
    let with_to = tag_req(vec![JobItem { from: "bulk/".into(), to: Some("x/".into()), is_prefix: true }], op.clone());
    expect_err(mgr.start(with_to, c.clone(), None), ErrorCode::InvalidInput, "a tag job with an item `to`")?;
    let eleven: Vec<Tag> = (0..11).map(|i| t(&format!("k{i}"), "v")).collect();
    let big = tag_req(vec![pre("bulk/")], TagOperation { mode: TagMode::Replace, set: eleven, remove: vec![] });
    expect_err(mgr.start(big, c.clone(), None), ErrorCode::InvalidInput, "replace with 11 tags")?;
    check(snap(c, A).await? == before, "nothing changed")?;
    check(mgr.list().is_empty(), "no job was created")?;

    // An object deleted between the listing and the work: per-object failure.
    let victim = "gone/v1";
    for k in [victim, "gone/v2", "gone/v3"] {
        put_tagged(c, A, k, &[]).await?;
    }
    let c2 = c.clone();
    let hook: AfterListingHook = Arc::new(move |_id: String| {
        let c = c2.clone();
        async move {
            let _ = c.delete_object().bucket(A).key(victim).send().await;
        }
        .boxed()
    });
    let tuned = JobManager::with_tuning(rec.clone(), JobTuning { after_listing: Some(hook), ..JobTuning::default() });
    let id = tuned.start(tag_req(vec![pre("gone/")], op), c.clone(), None)?;
    let j = tuned.wait(&id).await.ok_or("job vanished")?;
    check_job(rec, &j)?;
    println!("     {:?}", j.errors);
    check(
        j.total_items == 3 && j.done_items == 2 && j.failed_items == 1 && j.errors.first().is_some_and(|e| e.key == victim && e.message.contains("no longer exists")),
        "the vanished object is a per-object failure; the others were tagged",
    )?;
    Ok(())
}

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let ak = env("SMOKE_ACCESS_KEY", "minioadmin");
    let sk = env("SMOKE_SECRET_KEY", "minioadmin");
    let n: usize = env("TAGS_BULK", "2000").parse()?;
    let dir = PathBuf::from(env("TAGS_DIR", concat!(env!("CARGO_MANIFEST_DIR"), "/target/tags-e2e")));
    std::fs::create_dir_all(&dir)?;
    let only = std::env::var("TAGS_ONLY").ok();
    let run = |s: &str| only.as_deref().is_none_or(|o| o.contains(s));

    let conn = Connection::open(static_config(&endpoint, &ak, &sk)).await?;
    let c = conn.client_for_bucket(A).await;
    for b in [A, SHARED] {
        let _ = c.create_bucket().bucket(b).send().await;
    }
    wipe(&c, A).await?;
    wipe(&c, SHARED).await?;
    c.put_object().bucket(SHARED).key("shared.txt").body(ByteStream::from_static(b"shared")).send().await?;
    let rec = Arc::new(Recorder(Mutex::new(Vec::new())));
    let mgr = JobManager::new(rec.clone());
    let t0 = Instant::now();
    if run("0") {
        probe(&c).await?;
    }
    if run("1") {
        added_buckets(&endpoint, &conn, &dir).await?;
    }
    if run("2") {
        bucket_tags(&c).await?;
    }
    if run("3") {
        object_tags(&c).await?;
    }
    if run("4") {
        bulk(&c, &rec, &mgr, n).await?;
    }
    if run("5") {
        cancel(&c, &rec, &mgr, n).await?;
    }
    if run("6") {
        rejections(&c, &rec).await?;
    }
    wipe(&c, A).await?;
    wipe(&c, SHARED).await?;
    let _ = c.delete_bucket_tagging().bucket(A).send().await;
    let _ = std::fs::remove_dir_all(&dir);
    println!("ALL TAG CHECKS PASSED in {:.1}s", t0.elapsed().as_secs_f64());
    Ok(())
}
