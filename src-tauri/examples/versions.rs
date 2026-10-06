//! End-to-end tests for v0.5.0's object versions, archived-object restores, `disconnect` with
//! `cancelActive` and `delete_saved_connection` forgetting added buckets, against a local
//! S3-compatible server (SeaweedFS, see the smoke-test skill).
//!
//! Destructive steps (restore a version, permanently delete a version or a delete marker) diff a
//! full snapshot of every version in the bucket before and after, so what survived is asserted,
//! not only what changed.
//!
//! What SeaweedFS does not implement (RestoreObject, x-amz-restore) is probed and reported; the
//! restore paths that need real archives are covered by unit tests with a fake S3.
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin), VERSIONS_DIR (scratch dir, default target/versions-e2e).
//!
//! Run: `cargo run --example versions`

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{BucketVersioningStatus, StorageClass, VersioningConfiguration};
use aws_sdk_s3::Client;
use futures::stream::{self, StreamExt};
use s3explorer_lib::archive;
use s3explorer_lib::batches::BatchSink;
use s3explorer_lib::buckets::{self, AddedBucketStore, ADDED_BUCKETS_FILE};
use s3explorer_lib::error::{AppError, ErrorCode};
use s3explorer_lib::jobs::{JobManager, JobSink};
use s3explorer_lib::keychain::MemoryKeychain;
use s3explorer_lib::models::{
    AppSettings, Batch, BatchKind, BatchPlanRequest, BatchStatus, ConflictPolicy, ConnectionConfig, Job, JobItem,
    JobKind, JobPhase, JobRequest, JobStatus, RestoreRequest, RestoreTier, SaveConnectionInput, Transfer,
    TransferSettings, TransferStatus,
};
use s3explorer_lib::saved::{self, ConnectionStore, CONNECTIONS_FILE};
use s3explorer_lib::settings::SettingsStore;
use s3explorer_lib::state::{AppState, Connection};
use s3explorer_lib::transfers::{ProgressSink, TransferManager};
use s3explorer_lib::{ops, versions};
use sha2::{Digest, Sha256};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const VB: &str = "versions-v";
const PLAIN: &str = "versions-plain";
const KEY: &str = "docs/r e+port.txt";
const OTHER: &str = "docs/r e+port.txt.bak";

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

fn sha(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
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

// ---- probe ------------------------------------------------------------------------------------

fn probe_line<T, E: ProvideErrorMetadata>(what: &str, r: &Result<T, aws_sdk_s3::error::SdkError<E, aws_sdk_s3::config::http::HttpResponse>>) {
    match r {
        Ok(_) => println!("  probe {what}: supported"),
        Err(e) => println!(
            "  probe {what}: HTTP {:?} {:?} {:?}",
            e.raw_response().map(|r| r.status().as_u16()),
            e.as_service_error().and_then(|s| s.code()),
            e.as_service_error().and_then(|s| s.message())
        ),
    }
}

/// Reports what the server implements (informational; the scenarios below assert).
async fn probe(c: &Client) -> Res<()> {
    println!("probe: what this server supports");
    let b = "versions-probe";
    let _ = c.create_bucket().bucket(b).send().await;
    let r = c
        .put_bucket_versioning()
        .bucket(b)
        .versioning_configuration(VersioningConfiguration::builder().status(BucketVersioningStatus::Enabled).build())
        .send()
        .await;
    probe_line("PutBucketVersioning", &r);
    let v1 = c.put_object().bucket(b).key("p").body(ByteStream::from_static(b"1")).send().await?.version_id().map(str::to_string);
    let _ = c.put_object().bucket(b).key("p").body(ByteStream::from_static(b"2")).send().await?;
    println!("  probe PutObject returns a version id: {}", v1.is_some());
    let v1 = v1.unwrap_or_default();
    probe_line("ListObjectVersions", &c.list_object_versions().bucket(b).prefix("p").send().await);
    probe_line("GetObject versionId", &c.get_object().bucket(b).key("p").version_id(&v1).send().await);
    probe_line("HeadObject versionId", &c.head_object().bucket(b).key("p").version_id(&v1).send().await);
    probe_line(
        "CopyObject ?versionId=",
        &c.copy_object().bucket(b).key("p-copy").copy_source(format!("{b}/p?versionId={v1}")).send().await,
    );
    probe_line("GetObject unknown versionId", &c.get_object().bucket(b).key("p").version_id("nope").send().await);
    probe_line("HeadObject unknown versionId", &c.head_object().bucket(b).key("p").version_id("nope").send().await);
    probe_line("DeleteObject unknown versionId (S3 answers 204)", &c.delete_object().bucket(b).key("p").version_id("nope").send().await);
    probe_line("DeleteObject versionId", &c.delete_object().bucket(b).key("p").version_id(&v1).send().await);
    probe_line(
        "PutObject StorageClass=GLACIER",
        &c.put_object().bucket(b).key("g").storage_class(StorageClass::Glacier).body(ByteStream::from_static(b"g")).send().await,
    );
    let h = c.head_object().bucket(b).key("g").send().await?;
    println!("  probe HeadObject of GLACIER: storage class {:?}, x-amz-restore {:?}", h.storage_class(), h.restore());
    probe_line("GetObject of GLACIER (S3 refuses until restored)", &c.get_object().bucket(b).key("g").send().await);
    let rr = aws_sdk_s3::types::RestoreRequest::builder()
        .days(1)
        .glacier_job_parameters(aws_sdk_s3::types::GlacierJobParameters::builder().tier(aws_sdk_s3::types::Tier::Standard).build()?)
        .build();
    probe_line("RestoreObject", &c.restore_object().bucket(b).key("g").restore_request(rr).send().await);
    empty_bucket(c, b).await?;
    let _ = c.delete_bucket().bucket(b).send().await;
    Ok(())
}

// ---- helpers ----------------------------------------------------------------------------------

/// Deletes every version and delete marker of every key in `bucket`.
async fn empty_bucket(c: &Client, bucket: &str) -> Res<()> {
    loop {
        let page = match c.list_object_versions().bucket(bucket).send().await {
            Ok(p) => p,
            Err(_) => return Ok(()), // no such bucket
        };
        let mut all: Vec<(String, Option<String>)> = Vec::new();
        for v in page.versions() {
            all.push((v.key().unwrap_or_default().to_string(), v.version_id().map(str::to_string)));
        }
        for m in page.delete_markers() {
            all.push((m.key().unwrap_or_default().to_string(), m.version_id().map(str::to_string)));
        }
        if all.is_empty() {
            return Ok(());
        }
        stream::iter(all)
            .map(|(k, v)| async move { c.delete_object().bucket(bucket).key(k).set_version_id(v).send().await })
            .buffer_unordered(16)
            .collect::<Vec<_>>()
            .await;
    }
}

/// Every version of every key: (key, version id) -> (latest, marker, sha256 of content).
type Snap = BTreeMap<(String, String), (bool, bool, Option<String>)>;

async fn snapshot(c: &Client, bucket: &str) -> Res<Snap> {
    let page = c.list_object_versions().bucket(bucket).send().await?;
    if page.is_truncated() == Some(true) {
        return Err("snapshot: listing truncated".into());
    }
    let mut out = Snap::new();
    for v in page.versions() {
        let (k, id) = (v.key().unwrap_or_default().to_string(), v.version_id().unwrap_or("null").to_string());
        let body = c.get_object().bucket(bucket).key(&k).version_id(&id).send().await?.body.collect().await?.into_bytes();
        out.insert((k, id), (v.is_latest().unwrap_or(false), false, Some(sha(&body))));
    }
    for m in page.delete_markers() {
        let (k, id) = (m.key().unwrap_or_default().to_string(), m.version_id().unwrap_or("null").to_string());
        out.insert((k, id), (m.is_latest().unwrap_or(false), true, None));
    }
    Ok(out)
}

/// `after` equals `before` except for the keys in `changed` (which the caller checks itself).
fn unchanged_except(before: &Snap, after: &Snap, changed: &[(&str, &str)]) -> bool {
    let strip = |s: &Snap| -> Snap {
        s.iter()
            .filter(|((k, v), _)| !changed.iter().any(|(ck, cv)| ck == k && cv == v))
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect()
    };
    strip(before) == strip(after)
}

async fn current(c: &Client, bucket: &str, key: &str) -> Res<Option<Vec<u8>>> {
    match c.get_object().bucket(bucket).key(key).send().await {
        Ok(o) => Ok(Some(o.body.collect().await?.into_bytes().to_vec())),
        Err(e) if e.raw_response().map(|r| r.status().as_u16()) == Some(404) => Ok(None),
        Err(e) => Err(Box::new(e)),
    }
}

#[derive(Default)]
struct Rec {
    transfers: Mutex<Vec<Transfer>>,
    jobs: Mutex<Vec<Job>>,
    batches: Mutex<Vec<Batch>>,
}
struct TSink(Arc<Rec>);
impl ProgressSink for TSink {
    fn emit(&self, t: &Transfer) {
        if let Ok(mut v) = self.0.transfers.lock() {
            v.push(t.clone());
        }
    }
}
struct JSink(Arc<Rec>);
impl JobSink for JSink {
    fn emit(&self, j: &Job) {
        if let Ok(mut v) = self.0.jobs.lock() {
            v.push(j.clone());
        }
    }
}
struct BSink(Arc<Rec>);
impl BatchSink for BSink {
    fn emit(&self, b: &Batch) {
        if let Ok(mut v) = self.0.batches.lock() {
            v.push(b.clone());
        }
    }
}

// ---- scenarios --------------------------------------------------------------------------------

async fn versions_scenarios(c: &Client, dir: &Path) -> Res<()> {
    println!("versions: a versioned bucket, three versions and a delete marker");
    empty_bucket(c, VB).await?;
    let _ = c.create_bucket().bucket(VB).send().await;
    c.put_bucket_versioning()
        .bucket(VB)
        .versioning_configuration(VersioningConfiguration::builder().status(BucketVersioningStatus::Enabled).build())
        .send()
        .await?;
    let contents = [random(20 * 1024 * 1024 + 17, 1), b"version two".to_vec(), b"version three, the newest".to_vec()];
    let mut ids = Vec::new();
    for (i, body) in contents.iter().enumerate() {
        let out = c
            .put_object()
            .bucket(VB)
            .key(KEY)
            .content_type("text/plain")
            .metadata("n", (i + 1).to_string())
            .body(ByteStream::from(body.clone()))
            .send()
            .await?;
        ids.push(out.version_id().ok_or("no version id")?.to_string());
    }
    c.put_object().bucket(VB).key(OTHER).body(ByteStream::from_static(b"not the same key")).send().await?;
    c.put_object_tagging()
        .bucket(VB)
        .key(KEY)
        .version_id(&ids[0])
        .tagging(
            aws_sdk_s3::types::Tagging::builder()
                .tag_set(aws_sdk_s3::types::Tag::builder().key("t").value("v1").build()?)
                .build()?,
        )
        .send()
        .await
        .map(|_| ())
        .unwrap_or_else(|e| println!("  note: tagging a version failed ({:?}); tag carry-over not checked", e.code()));

    let l = versions::list_object_versions(c, VB, KEY).await?;
    let got: Vec<&str> = l.versions.iter().map(|v| v.version_id.as_str()).collect();
    check(got == [ids[2].as_str(), ids[1].as_str(), ids[0].as_str()], "three versions, newest first, only the exact key")?;
    check(l.versions[0].is_latest && !l.versions[1].is_latest && !l.versions[2].is_latest, "only the newest is latest")?;
    check(l.versions[2].size == contents[0].len() as u64 && !l.truncated, "sizes, not truncated")?;

    // Download version 1 (20 MiB: the parallel ranged path) and hash it.
    let tm = TransferManager::with_settings(Arc::new(|_: &Transfer| {}), TransferSettings::default());
    let dest = dir.join("v1.bin");
    let id = tm.start_version_download(c.clone(), VB, KEY, &ids[0], dest.clone())?;
    let t = tm.wait(&id).await.ok_or("unknown transfer")?;
    check(t.status == TransferStatus::Completed && t.parts_total > 1, &format!("version 1 downloaded in {} parts", t.parts_total))?;
    check(sha(&std::fs::read(&dest)?) == sha(&contents[0]), "version 1 sha256 matches the original")?;
    let id = tm.start_version_download(c.clone(), VB, KEY, "no-such-version-id", dir.join("x.bin"))?;
    let t = tm.wait(&id).await.ok_or("unknown transfer")?;
    check(
        t.status == TransferStatus::Failed
            && t.error.as_deref() == Some(&format!("Version no-such-version-id of {KEY} does not exist.") as &str),
        &format!("unknown version download fails: {:?}", t.error),
    )?;
    check(!dir.join("x.bin").exists(), "nothing written for it")?;

    // Restore version 1: new current with that content; the old current becomes noncurrent.
    let before = snapshot(c, VB).await?;
    let entry = versions::restore_object_version(c, VB, KEY, &ids[0]).await?;
    let after = snapshot(c, VB).await?;
    check(entry.key == KEY && entry.size == contents[0].len() as u64, "restore returns the new current object")?;
    check(current(c, VB, KEY).await?.map(|b| sha(&b)) == Some(sha(&contents[0])), "current content is version 1's")?;
    let l = versions::list_object_versions(c, VB, KEY).await?;
    let new_id = l.versions[0].version_id.clone();
    check(l.versions.len() == 4 && l.versions[0].is_latest && !ids.contains(&new_id), "a new latest version")?;
    check(l.versions.iter().any(|v| v.version_id == ids[2] && !v.is_latest), "the previous current (v3) is noncurrent")?;
    check(after.len() == before.len() + 1, "exactly one version added")?;
    let mut expected = before.clone();
    for ((k, v), e) in expected.iter_mut() {
        if k == KEY && v == &ids[2] {
            e.0 = false;
        }
    }
    check(unchanged_except(&expected, &after, &[(KEY, &new_id)]), "every other version (and the other key) is untouched")?;
    let h = c.head_object().bucket(VB).key(KEY).send().await?;
    check(h.content_type() == Some("text/plain") && h.metadata().and_then(|m| m.get("n")).map(String::as_str) == Some("1"), "metadata and content type of version 1 carried over")?;
    if let Ok(tg) = c.get_object_tagging().bucket(VB).key(KEY).send().await {
        println!("  info tags on the restored current version: {:?}", tg.tag_set().iter().map(|t| (t.key(), t.value())).collect::<Vec<_>>());
    }
    expect_err(versions::restore_object_version(c, VB, KEY, &new_id).await, ErrorCode::InvalidInput, "restoring the latest is refused")?;
    let e = expect_err(versions::restore_object_version(c, VB, KEY, "no-such-version-id").await, ErrorCode::NoSuchKey, "restoring an unknown version")?;
    check(e.message == format!("Version no-such-version-id of {KEY} does not exist."), "the message names the version")?;

    // Permanently delete a middle version (v2).
    let before = snapshot(c, VB).await?;
    versions::delete_object_version(c, VB, KEY, &ids[1]).await?;
    let after = snapshot(c, VB).await?;
    check(!after.contains_key(&(KEY.to_string(), ids[1].clone())), "version 2 is gone")?;
    check(after.len() + 1 == before.len() && unchanged_except(&before, &after, &[(KEY, &ids[1])]), "nothing else changed")?;
    expect_err(versions::delete_object_version(c, VB, KEY, &ids[1]).await, ErrorCode::NoSuchKey, "deleting it again")?;
    let before = snapshot(c, VB).await?;
    expect_err(versions::delete_object_version(c, VB, KEY, "no-such-version-id").await, ErrorCode::NoSuchKey, "deleting an unknown version")?;
    check(snapshot(c, VB).await? == before, "an unknown version id deletes nothing")?;

    // A delete marker, then remove it: the object reappears.
    c.delete_object().bucket(VB).key(KEY).send().await?;
    check(current(c, VB, KEY).await?.is_none(), "after a plain delete the object is gone")?;
    let l = versions::list_object_versions(c, VB, KEY).await?;
    let marker = l.versions[0].clone();
    check(marker.is_delete_marker && marker.is_latest && marker.size == 0, "the delete marker is listed first, latest")?;
    check(l.versions.len() == 4 && l.versions[1].version_id == new_id && !l.versions[1].is_latest, "order: marker, restored, v3, v1")?;
    let found = versions::find_version(c, VB, KEY, &marker.version_id).await?;
    check(found.is_delete_marker, "download_object_version would refuse it (delete marker)")?;
    expect_err(versions::restore_object_version(c, VB, KEY, &marker.version_id).await, ErrorCode::InvalidInput, "restoring a delete marker")?;
    let before = snapshot(c, VB).await?;
    versions::delete_object_version(c, VB, KEY, &marker.version_id).await?;
    let after = snapshot(c, VB).await?;
    check(current(c, VB, KEY).await?.map(|b| sha(&b)) == Some(sha(&contents[0])), "removing the marker brings the object back")?;
    let mut expected = before.clone();
    expected.remove(&(KEY.to_string(), marker.version_id.clone()));
    if let Some(e) = expected.get_mut(&(KEY.to_string(), new_id.clone())) {
        e.0 = true;
    }
    check(after == expected, "only the marker went; the restored version is latest again")?;

    println!("versions: a bucket that never had versioning");
    empty_bucket(c, PLAIN).await?;
    let _ = c.create_bucket().bucket(PLAIN).send().await;
    c.put_object().bucket(PLAIN).key("plain.txt").body(ByteStream::from_static(b"plain content")).send().await?;
    let l = versions::list_object_versions(c, PLAIN, "plain.txt").await?;
    check(l.versions.len() == 1 && l.versions[0].version_id == "null" && l.versions[0].is_latest, "one \"null\" version")?;
    let id = tm.start_version_download(c.clone(), PLAIN, "plain.txt", "null", dir.join("null.bin"))?;
    let t = tm.wait(&id).await.ok_or("unknown transfer")?;
    check(t.status == TransferStatus::Completed && std::fs::read(dir.join("null.bin"))? == b"plain content", "downloading version \"null\"")?;
    expect_err(versions::restore_object_version(c, PLAIN, "plain.txt", "null").await, ErrorCode::InvalidInput, "restoring the only version")?;
    let l = versions::list_object_versions(c, PLAIN, "missing.txt").await?;
    check(l.versions.is_empty(), "a missing key has no versions")?;
    Ok(())
}

async fn archive_scenarios(c: &Client) -> Res<()> {
    println!("archive: head_object, restore_object and the restore job");
    let prefix = "arch/";
    for k in ["arch/a.txt", "arch/sub/b.txt", "arch/sub/c.txt"] {
        c.put_object().bucket(PLAIN).key(k).body(ByteStream::from_static(b"standard")).send().await?;
    }
    c.put_object().bucket(PLAIN).key("cold/g.txt").storage_class(StorageClass::Glacier).body(ByteStream::from_static(b"g")).send().await?;
    c.put_object().bucket(PLAIN).key("cold/d.txt").storage_class(StorageClass::DeepArchive).body(ByteStream::from_static(b"d")).send().await?;

    let m = ops::head_object(c, PLAIN, "arch/a.txt").await?;
    check(!m.archived && m.restore.is_none(), "a STANDARD object is not archived")?;
    let m = ops::head_object(c, PLAIN, "cold/g.txt").await?;
    check(m.archived && m.restore.is_none() && m.storage_class.as_deref() == Some("GLACIER"), "a GLACIER object is archived, no restore yet")?;
    let req = |tier, days| RestoreRequest { tier, days };
    expect_err(archive::restore_object(c, PLAIN, "arch/a.txt", &req(RestoreTier::Standard, 7)).await, ErrorCode::InvalidInput, "restore of a STANDARD object")?;
    expect_err(archive::restore_object(c, PLAIN, "cold/g.txt", &req(RestoreTier::Standard, 0)).await, ErrorCode::InvalidInput, "days 0")?;
    expect_err(archive::restore_object(c, PLAIN, "cold/d.txt", &req(RestoreTier::Expedited, 3)).await, ErrorCode::InvalidInput, "Expedited on DEEP_ARCHIVE (before any request)")?;
    expect_err(archive::restore_object(c, PLAIN, "cold/g.txt", &req(RestoreTier::Standard, 7)).await, ErrorCode::NotSupported, "RestoreObject on this server")?;

    let rec = Arc::new(Rec::default());
    let jm = JobManager::new(Arc::new(JSink(rec.clone())));
    let job_req = |items: Vec<JobItem>, tier| JobRequest {
        kind: JobKind::Restore,
        src_bucket: PLAIN.into(),
        dest_bucket: None,
        items,
        on_conflict: ConflictPolicy::Skip,
        tags: None,
        restore: Some(req(tier, 7)),
    };
    let before = snapshot(c, PLAIN).await?;
    let id = jm.start(job_req(vec![JobItem { from: prefix.into(), to: None, is_prefix: true }], RestoreTier::Bulk), c.clone(), None)?;
    let j = jm.wait(&id).await.ok_or("unknown job")?;
    check(
        j.status == JobStatus::Completed && (j.total_items, j.done_items, j.skipped_items, j.failed_items) == (3, 0, 3, 0),
        &format!("restore job over a folder with nothing archived: all skipped ({}/{}/{}/{})", j.total_items, j.done_items, j.skipped_items, j.failed_items),
    )?;
    check(j.label == "Restore arch" && j.total_bytes == 0 && j.done_bytes == 0, &format!("label {:?}, no bytes", j.label))?;
    let ev: Vec<Job> = rec.jobs.lock().map(|v| v.iter().filter(|e| e.id == id).cloned().collect()).unwrap_or_default();
    check(
        ev.first().is_some_and(|e| e.status == JobStatus::Queued) && ev.last().is_some_and(|e| e.phase == JobPhase::Done && e.finished_at.is_some()),
        "first event queued, last carries finishedAt",
    )?;
    let id = jm.start(job_req(vec![JobItem { from: "cold/".into(), to: None, is_prefix: true }], RestoreTier::Standard), c.clone(), None)?;
    let j = jm.wait(&id).await.ok_or("unknown job")?;
    check(
        j.status == JobStatus::Failed && j.error.as_deref().is_some_and(|e| e.starts_with("Stopped: This server does not support restoring")),
        &format!("restore job on archived objects stops: {:?}", j.error),
    )?;
    let id = jm.start(job_req(vec![JobItem { from: "cold/d.txt".into(), to: None, is_prefix: false }], RestoreTier::Expedited), c.clone(), None)?;
    let j = jm.wait(&id).await.ok_or("unknown job")?;
    check(
        j.failed_items == 1 && j.errors.first().map(|e| e.message.as_str()) == Some(archive::EXPEDITED_DEEP_ARCHIVE),
        "Expedited on DEEP_ARCHIVE is a per-object failure",
    )?;
    // Exactly what the frontend sends: folders plus objects, onConflict skip.
    let wire: JobRequest = serde_json::from_str(&format!(
        r#"{{"kind":"restore","srcBucket":"{PLAIN}","destBucket":null,"items":[{{"from":"arch/sub/","to":null,"isPrefix":true}},{{"from":"arch/a.txt","to":null,"isPrefix":false}}],"onConflict":"skip","restore":{{"tier":"Standard","days":7}}}}"#
    ))?;
    let id = jm.start(wire, c.clone(), None)?;
    let j = jm.wait(&id).await.ok_or("unknown job")?;
    check(
        j.status == JobStatus::Completed && (j.total_items, j.skipped_items) == (3, 3) && j.label == "Restore 2 items",
        &format!("the frontend's JSON restore request (folder + object): {} skipped, label {:?}", j.skipped_items, j.label),
    )?;
    check(snapshot(c, PLAIN).await? == before, "the restore jobs changed nothing")?;
    Ok(())
}

async fn disconnect_scenario(endpoint: &str, ak: &str, sk: &str, dir: &Path) -> Res<()> {
    println!("disconnect {{ cancelActive: true }} during a running batch and job");
    let rec = Arc::new(Rec::default());
    let settings = AppSettings { part_size_mib: Some(1), max_concurrent_parts: 1, max_concurrent_transfers: 1, ..AppSettings::default() };
    let state = AppState::new(
        Arc::new(TSink(rec.clone())),
        Arc::new(JSink(rec.clone())),
        Arc::new(BSink(rec.clone())),
        SettingsStore::in_memory(settings),
    );
    let conn = Connection::open(static_config(endpoint, ak, sk)).await?;
    state.set_connection(Some(Arc::new(conn))).await;
    let c = state.client_for_bucket(PLAIN).await?;

    // Seed: 300 files of 256 KiB for the batch, 3,000 tiny objects for a copy job.
    let t0 = Instant::now();
    let seed: Vec<(String, Vec<u8>)> = (0..300)
        .map(|i| (format!("dc/batch/f{i:04}.bin"), random(256 * 1024, i)))
        .chain((0..3000).map(|i| (format!("dc/job/o{i:05}"), format!("object {i}").into_bytes())))
        .collect();
    let c2 = c.clone();
    let failures = stream::iter(seed)
        .map(|(k, b)| {
            let c = c2.clone();
            async move { c.put_object().bucket(PLAIN).key(k).body(ByteStream::from(b)).send().await.is_err() }
        })
        .buffer_unordered(32)
        .filter(|failed| futures::future::ready(*failed))
        .count()
        .await;
    check(failures == 0, &format!("seeded 3,300 objects in {:.1} s", t0.elapsed().as_secs_f64()))?;
    let source_before = ops::list_all_keys(&c, PLAIN, "dc/job/").await?;

    let out = dir.join("batch-out");
    let _ = std::fs::remove_dir_all(&out);
    let batch = state.batches.start(
        BatchPlanRequest {
            kind: BatchKind::Download,
            bucket: PLAIN.into(),
            prefix: "dc/batch/".into(),
            local_path: out.to_string_lossy().into_owned(),
            on_conflict: ConflictPolicy::Overwrite,
        },
        c.clone(),
    )?;
    let job = state.jobs.start(
        JobRequest {
            kind: JobKind::Copy,
            src_bucket: PLAIN.into(),
            dest_bucket: Some(PLAIN.into()),
            items: vec![JobItem { from: "dc/job/".into(), to: Some("dc/copy/".into()), is_prefix: true }],
            on_conflict: ConflictPolicy::Overwrite,
            tags: None,
            restore: None,
        },
        c.clone(),
        Some(c.clone()),
    )?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let b = state.batches.get(&batch).ok_or("batch")?;
        let j = state.jobs.get(&job).ok_or("job")?;
        if b.done_files >= 3 && j.phase == JobPhase::Working && j.done_items >= 10 {
            println!("  info before disconnect: batch {}/{} files, job {}/{} objects", b.done_files, b.total_files, j.done_items, j.total_items);
            break;
        }
        if Instant::now() > deadline || !b.status.is_active() || !j.status.is_active() {
            return Err(format!("FAILED: work did not get going or finished too early: {b:?} {j:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = Instant::now();
    let unfinished = state.disconnect(true, Duration::from_secs(10)).await;
    let took = started.elapsed();
    check(unfinished == 0, &format!("everything finished within the wait ({} ms)", took.as_millis()))?;
    check(state.connection_info().await.is_none(), "the connection is gone")?;
    check(!state.transfers.has_active() && !state.jobs.has_active() && !state.batches.has_active(), "nothing is active")?;
    let b = state.batches.get(&batch).ok_or("batch")?;
    let j = state.jobs.get(&job).ok_or("job")?;
    check(b.status == BatchStatus::Cancelled && b.done_files < b.total_files, &format!("batch cancelled at {}/{} files", b.done_files, b.total_files))?;
    check(j.status == JobStatus::Cancelled && j.done_items < j.total_items, &format!("job cancelled at {}/{} objects", j.done_items, j.total_items))?;
    let batch_final = rec.batches.lock().map(|v| v.iter().filter(|e| e.id == batch && e.finished_at.is_some()).count()).unwrap_or(0);
    let job_final = rec.jobs.lock().map(|v| v.iter().filter(|e| e.id == job && e.finished_at.is_some()).count()).unwrap_or(0);
    check(batch_final == 1 && job_final == 1, "exactly one final event each, emitted before disconnect returned")?;
    let transfers = state.transfers.list();
    let finals_ok = transfers.iter().all(|t| {
        !t.status.is_active()
            && rec.transfers.lock().map(|v| v.iter().any(|e| e.id == t.id && e.finished_at.is_some())).unwrap_or(false)
    });
    check(finals_ok, &format!("all {} batch transfers ended with a final event", transfers.len()))?;
    let cancelled = transfers.iter().filter(|t| t.status == TransferStatus::Cancelled).count();
    check(cancelled > 0, &format!("{cancelled} transfers cancelled"))?;
    let leftovers: Vec<String> = std::fs::read_dir(&out)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".part")).collect())
        .unwrap_or_default();
    check(leftovers.is_empty(), "no temp files left behind")?;
    let files = std::fs::read_dir(&out).map(|d| d.count()).unwrap_or(0) as u64;
    check(files == b.done_files, &format!("{files} files on disk = doneFiles"))?;
    // The job: every copy that counts as done exists, sources are untouched.
    let copies = ops::list_all_keys(&c, PLAIN, "dc/copy/").await?;
    check(copies.len() as u64 == j.done_items, &format!("{} copies = doneItems", copies.len()))?;
    check(ops::list_all_keys(&c, PLAIN, "dc/job/").await? == source_before, "the job's sources are untouched")?;

    // The old client still works for anyone holding it (disconnect only drops the state's copy).
    check(c.head_bucket().bucket(PLAIN).send().await.is_ok(), "a client taken before disconnect keeps working")?;
    for p in ["dc/"] {
        let keys = ops::list_all_keys(&c, PLAIN, p).await?;
        for chunk in keys.chunks(1000) {
            let objs: Vec<_> = chunk.iter().map(|k| aws_sdk_s3::types::ObjectIdentifier::builder().key(k).build()).collect::<Result<_, _>>()?;
            c.delete_objects().bucket(PLAIN).delete(aws_sdk_s3::types::Delete::builder().set_objects(Some(objs)).build()?).send().await?;
        }
    }
    let _ = std::fs::remove_dir_all(&out);
    Ok(())
}

async fn saved_scenario(endpoint: &str, ak: &str, sk: &str, dir: &Path) -> Res<()> {
    println!("delete_saved_connection forgets the connection's added buckets");
    let sdir = dir.join("saved");
    let _ = std::fs::remove_dir_all(&sdir);
    std::fs::create_dir_all(&sdir)?;
    let store = ConnectionStore::load(sdir.join(CONNECTIONS_FILE), Arc::new(MemoryKeychain::new()));
    let added = AddedBucketStore::load(sdir.join(ADDED_BUCKETS_FILE));
    let state = AppState::new(
        Arc::new(|_: &Transfer| {}),
        Arc::new(|_: &Job| {}),
        Arc::new(|_: &Batch| {}),
        SettingsStore::in_memory(AppSettings::default()),
    );
    let saved_a = store.save(SaveConnectionInput { id: None, name: "e2e-a".into(), config: static_config(endpoint, ak, sk) }).await?;
    let saved_b = store.save(SaveConnectionInput { id: None, name: "e2e-b".into(), config: static_config(endpoint, ak, sk) }).await?;
    for (s, bucket) in [(&saved_a, PLAIN), (&saved_a, VB), (&saved_b, PLAIN)] {
        saved::connect_saved(&store, &state, &s.id).await?;
        let conn = state.connection().await?;
        check(conn.identity == s.id, "added buckets are keyed by the saved connection id")?;
        let (client, region) = conn.resolve_bucket(bucket).await;
        buckets::add(&added, &conn.identity, bucket, &client, region).await?;
    }
    check(added.list(&saved_a.id).await.len() == 2 && added.list(&saved_b.id).await.len() == 1, "three added buckets on two connections")?;
    saved::delete_saved_connection(&store, &added, &saved_a.id).await?;
    let reloaded = AddedBucketStore::load(sdir.join(ADDED_BUCKETS_FILE));
    check(reloaded.list(&saved_a.id).await.is_empty(), "the deleted connection's buckets are gone from added-buckets.json")?;
    check(reloaded.list(&saved_b.id).await.len() == 1, "the other connection keeps its bucket")?;
    let text = std::fs::read_to_string(sdir.join(ADDED_BUCKETS_FILE))?;
    check(!text.contains(&saved_a.id), "the file no longer mentions the deleted id")?;
    check(store.list().await?.iter().all(|s| s.id != saved_a.id), "the connection itself is deleted")?;
    let _ = std::fs::remove_dir_all(&sdir);
    Ok(())
}

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let ak = env("SMOKE_ACCESS_KEY", "minioadmin");
    let sk = env("SMOKE_SECRET_KEY", "minioadmin");
    let default_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("versions-e2e");
    let dir = PathBuf::from(env("VERSIONS_DIR", &default_dir.to_string_lossy()));
    std::fs::create_dir_all(&dir)?;

    let conn = Connection::open(static_config(&endpoint, &ak, &sk)).await?;
    let c = conn.client_for_bucket(VB).await;
    probe(&c).await?;
    versions_scenarios(&c, &dir).await?;
    archive_scenarios(&c).await?;
    disconnect_scenario(&endpoint, &ak, &sk, &dir).await?;
    saved_scenario(&endpoint, &ak, &sk, &dir).await?;

    empty_bucket(&c, VB).await?;
    empty_bucket(&c, PLAIN).await?;
    let _ = c.delete_bucket().bucket(VB).send().await;
    let _ = c.delete_bucket().bucket(PLAIN).send().await;
    let _ = std::fs::remove_dir_all(&dir);
    println!("versions: all checks passed");
    Ok(())
}
