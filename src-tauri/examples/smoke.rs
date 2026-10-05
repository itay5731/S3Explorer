//! End-to-end smoke test against a local S3-compatible server (no Tauri involved).
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin), SMOKE_DIR (scratch dir for files, default temp dir).
//!
//! Run: `cargo run --example smoke`

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use s3explorer_lib::error::ErrorCode;
use s3explorer_lib::jobs::{JobManager, NoopJobSink};
use s3explorer_lib::models::{
    ConflictPolicy, ConnectionConfig, Job, JobItem, JobKind, JobRequest, JobStatus, Transfer, TransferSettings,
    TransferStatus,
};
use s3explorer_lib::ops;
use s3explorer_lib::state::Connection;
use s3explorer_lib::transfers::{ProgressSink, TransferManager};
use sha2::{Digest, Sha256};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn random_bytes(len: usize, mut seed: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(len + 8);
    while v.len() < len {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        v.extend_from_slice(&seed.to_le_bytes());
    }
    v.truncate(len);
    v
}

fn sha(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn check(cond: bool, what: &str) -> Res<()> {
    if cond {
        println!("  ok  {what}");
        Ok(())
    } else {
        Err(format!("FAILED: {what}").into())
    }
}

struct Recorder {
    events: Mutex<Vec<Transfer>>,
    count: AtomicUsize,
}
impl ProgressSink for Recorder {
    fn emit(&self, t: &Transfer) {
        self.count.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut e) = self.events.lock() {
            e.push(t.clone());
        }
    }
}

/// True if any `*.part` temp file is left in `dir`.
fn part_files_exist(dir: &std::path::Path) -> std::io::Result<bool> {
    Ok(std::fs::read_dir(dir)?.filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().ends_with(".part")))
}

/// Deletes every object under `prefix` with a delete job (`delete_folder` is gone since v0.3.0).
/// An empty prefix is fine here (the job then reports one "nothing found" failure).
async fn delete_prefix(client: &aws_sdk_s3::Client, bucket: &str, prefix: &str) -> Res<Job> {
    let jobs = JobManager::new(Arc::new(NoopJobSink));
    let request = JobRequest {
        kind: JobKind::Delete,
        src_bucket: bucket.into(),
        dest_bucket: None,
        items: vec![JobItem { from: prefix.into(), to: None, is_prefix: true }],
        on_conflict: ConflictPolicy::Skip,
    };
    let id = jobs.start(request, client.clone(), None)?;
    let job = jobs.wait(&id).await.ok_or("missing job")?;
    let empty = job.total_items == 1 && job.failed_items == 1;
    if job.status != JobStatus::Completed && !empty {
        return Err(format!("delete of {prefix} failed: {job:?}").into());
    }
    Ok(job)
}

fn settings(part_size_mib: Option<u32>, parts: u32, transfers: u32) -> TransferSettings {
    let s = TransferSettings {
        part_size_mib,
        max_concurrent_parts: parts,
        max_concurrent_transfers: transfers,
        ..Default::default()
    };
    assert!(s.validate().is_ok());
    s
}

/// Highest number of `ids` simultaneously `running`, replaying the events in emit order.
fn max_running(events: &[Transfer], ids: &[String]) -> usize {
    let mut status: HashMap<&str, TransferStatus> = HashMap::new();
    let mut max = 0;
    for t in events.iter().filter(|t| ids.contains(&t.id)) {
        status.insert(&t.id, t.status);
        max = max.max(status.values().filter(|s| **s == TransferStatus::Running).count());
    }
    max
}

fn first_event(events: &[Transfer], id: &str, status: TransferStatus) -> Option<usize> {
    events.iter().position(|t| t.id == id && t.status == status)
}

/// Transfer settings against the real server: part size, parts in flight, transfer limit.
async fn settings_checks(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    dir: &std::path::Path,
    big: &[u8],
    big_src: &std::path::Path,
    big_mib: u64,
) -> Res<()> {
    println!("settings");
    let out = dir.join("settings-out");
    let _ = tokio::fs::remove_dir_all(&out).await;
    delete_prefix(client, bucket, "smoke-settings/").await?;
    let rec = Arc::new(Recorder { events: Mutex::new(Vec::new()), count: AtomicUsize::new(0) });
    let tm = TransferManager::with_settings(rec.clone(), settings(Some(4), 3, 4));
    let src_key = "smoke/data/big.bin";
    let want_sha = sha(big);

    // partSizeMib=4, maxConcurrentParts=3.
    let id = tm.start_download(client.clone(), bucket, src_key, out.join("p4.bin"))?;
    let t = tm.wait(&id).await.ok_or("missing transfer")?;
    let peak = tm.peak_parts_in_flight(&id).unwrap_or(0);
    println!("  4 MiB parts: {:?} parts {}/{}, peak parts in flight {peak}", t.status, t.parts_done, t.parts_total);
    check(t.status == TransferStatus::Completed, "4 MiB download completed")?;
    check(u64::from(t.parts_total) == big_mib.div_ceil(4), "partSizeMib=4 -> partsTotal = ceil(size / 4 MiB)")?;
    check((1..=3).contains(&peak), "peak parts in flight <= maxConcurrentParts (3)")?;
    check(sha(&tokio::fs::read(out.join("p4.bin")).await?) == want_sha, "4 MiB parts sha256 matches")?;

    // partSizeMib=64: a 40 MiB object is one GET.
    tm.apply_settings(&settings(Some(64), 8, 4));
    let id = tm.start_download(client.clone(), bucket, src_key, out.join("p64.bin"))?;
    let t = tm.wait(&id).await.ok_or("missing transfer")?;
    let peak = tm.peak_parts_in_flight(&id).unwrap_or(0);
    println!("  64 MiB parts: {:?} parts {}/{}, peak {peak}", t.status, t.parts_done, t.parts_total);
    let expect = if big_mib > 64 { big_mib.div_ceil(64) } else { 1 };
    check(t.status == TransferStatus::Completed, "64 MiB download completed")?;
    check(u64::from(t.parts_total) == expect && t.parts_done == t.parts_total, "partSizeMib=64 -> single GET")?;
    check(sha(&tokio::fs::read(out.join("p64.bin")).await?) == want_sha, "64 MiB parts sha256 matches")?;

    // partSizeMib=1 upload: raised to the 5 MiB S3 minimum.
    tm.apply_settings(&settings(Some(1), 8, 4));
    let up_key = "smoke-settings/big-1m.bin";
    let id = tm.start_upload(client.clone(), bucket, up_key, big_src.to_path_buf());
    let t = tm.wait(&id).await.ok_or("missing transfer")?;
    let peak = tm.peak_parts_in_flight(&id).unwrap_or(0);
    println!("  1 MiB upload: {:?} {:?} parts {}/{}, peak {peak}", t.status, t.error, t.parts_done, t.parts_total);
    check(t.status == TransferStatus::Completed, "1 MiB-setting upload completed")?;
    check(u64::from(t.parts_total) == big_mib.div_ceil(5), "upload used 5 MiB parts")?;
    check(peak <= 8, "upload peak parts in flight <= 8")?;
    let meta = ops::head_object(client, bucket, up_key).await?;
    check(meta.size == big.len() as u64, "5 MiB-part upload size")?;
    let id = tm.start_download(client.clone(), bucket, up_key, out.join("up1.bin"))?;
    let t = tm.wait(&id).await.ok_or("missing transfer")?;
    check(
        t.status == TransferStatus::Completed && sha(&tokio::fs::read(out.join("up1.bin")).await?) == want_sha,
        "5 MiB-part upload round-trips (sha256)",
    )?;

    // maxConcurrentTransfers=1: never more than one running. Small slow parts keep each running a while.
    tm.apply_settings(&settings(Some(1), 1, 1));
    let ids: Vec<String> = (0..3)
        .map(|i| tm.start_download(client.clone(), bucket, src_key, out.join(format!("lim1-{i}.bin"))))
        .collect::<Result<_, _>>()?;
    for id in &ids {
        let t = tm.wait(id).await.ok_or("missing transfer")?;
        check(t.status == TransferStatus::Completed, "limit=1 download completed")?;
    }
    let mx = max_running(&rec.events.lock().map_err(|_| "poisoned")?, &ids);
    println!("  limit 1: max running observed {mx}");
    check(mx == 1, "maxConcurrentTransfers=1 -> never more than 1 running")?;

    // Raise to 3 while #0 runs: #1 and #2 start at once, with the part size in effect when they start.
    let ids: Vec<String> = (0..3)
        .map(|i| tm.start_download(client.clone(), bucket, src_key, out.join(format!("raise-{i}.bin"))))
        .collect::<Result<_, _>>()?;
    let t0 = Instant::now();
    while tm.get(&ids[0]).is_some_and(|t| t.status == TransferStatus::Queued) && t0.elapsed().as_secs() < 10 {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    let queued: Vec<_> = ids[1..].iter().filter_map(|id| tm.get(id)).map(|t| t.status).collect();
    println!("  before raise: #0 {:?}, others {queued:?}", tm.get(&ids[0]).map(|t| t.status));
    check(queued.iter().all(|s| *s == TransferStatus::Queued), "others queued while limit=1")?;
    tm.apply_settings(&settings(Some(2), 1, 3));
    let mut finals = Vec::new();
    for id in &ids {
        finals.push(tm.wait(id).await.ok_or("missing transfer")?);
    }
    let ev = rec.events.lock().map_err(|_| "poisoned")?.clone();
    let mx = max_running(&ev, &ids);
    let done0 = first_event(&ev, &ids[0], TransferStatus::Completed).unwrap_or(0);
    let started_early = ids[1..]
        .iter()
        .all(|id| first_event(&ev, id, TransferStatus::Running).is_some_and(|i| i < done0));
    println!(
        "  raise to 3: max running {mx}, queued ones started before #0 finished: {started_early}, parts {:?}",
        finals.iter().map(|t| t.parts_total).collect::<Vec<_>>()
    );
    check(finals.iter().all(|t| t.status == TransferStatus::Completed), "raised-limit downloads completed")?;
    check(started_early, "raising the limit starts queued transfers immediately")?;
    check((2..=3).contains(&mx), "running count rose above 1 and stayed <= 3")?;
    check(u64::from(finals[0].parts_total) == big_mib, "#0 kept the 1 MiB part size it started with")?;
    check(
        finals[1..].iter().all(|t| u64::from(t.parts_total) == big_mib.div_ceil(2)),
        "queued transfers snapshot the part size when they start (2 MiB)",
    )?;
    for i in 0..3 {
        check(sha(&tokio::fs::read(out.join(format!("raise-{i}.bin"))).await?) == want_sha, "raised-limit sha256")?;
    }

    delete_prefix(client, bucket, "smoke-settings/").await?;
    let _ = tokio::fs::remove_dir_all(&out).await;
    Ok(())
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

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let ak = env("SMOKE_ACCESS_KEY", "minioadmin");
    let sk = env("SMOKE_SECRET_KEY", "minioadmin");
    let dir = PathBuf::from(env("SMOKE_DIR", &std::env::temp_dir().join("s3explorer-smoke").to_string_lossy()));
    tokio::fs::create_dir_all(&dir).await?;
    let bucket = "smoke-bucket";

    println!("connect");
    let bad = Connection::open(static_config(&endpoint, &ak, "wrong-secret")).await;
    match &bad {
        Err(e) => println!("  bad creds -> {:?}: {}", e.code, e.message),
        Ok(_) => println!("  bad creds unexpectedly accepted"),
    }
    check(matches!(&bad, Err(e) if e.code == ErrorCode::Auth || e.code == ErrorCode::AccessDenied), "wrong secret rejected")?;
    let conn = Connection::open(static_config(&endpoint, &ak, &sk)).await?;
    println!("  info = {}", serde_json::to_string(&conn.info)?);
    check(conn.info.can_list_buckets, "canListBuckets")?;
    check(conn.info.label.starts_with("static:"), "label")?;

    let client = conn.client_for_bucket(bucket).await;
    if let Err(e) = client.create_bucket().bucket(bucket).send().await {
        println!("  create_bucket: {}", s3explorer_lib::error::AppError::from(e).message);
    }
    let buckets = ops::list_buckets(conn.base_client()).await?;
    check(buckets.iter().any(|b| b.name == bucket), "bucket listed")?;
    // Start from a clean slate.
    delete_prefix(&client, bucket, "smoke/").await?;

    println!("folders");
    ops::create_folder(&client, bucket, "smoke/data").await?;
    let root = ops::list_objects(&client, bucket, "", None, None).await?;
    check(root.folders.iter().any(|f| f.prefix == "smoke/" && f.name == "smoke"), "root shows smoke/")?;
    let inner = ops::list_objects(&client, bucket, "smoke/data/", None, None).await?;
    check(inner.objects.is_empty() && inner.folders.is_empty(), "marker excluded from listing")?;

    println!("upload");
    let big_mib: u64 = env("SMOKE_BIG_MIB", "40").parse()?;
    let parts = big_mib.div_ceil(8) as u32;
    let big = random_bytes((big_mib * 1024 * 1024) as usize, 0x9E37_79B9_7F4A_7C15);
    let small = b"hello from s3explorer\n".to_vec();
    let big_src = dir.join("big-src.bin");
    let small_src = dir.join("small.txt");
    tokio::fs::write(&big_src, &big).await?;
    tokio::fs::write(&small_src, &small).await?;

    let rec = Arc::new(Recorder { events: Mutex::new(Vec::new()), count: AtomicUsize::new(0) });
    let tm = TransferManager::new(rec.clone());
    let t0 = Instant::now();
    let up_big = tm.start_upload(client.clone(), bucket, "smoke/data/big.bin", big_src.clone());
    let up_small = tm.start_upload(client.clone(), bucket, "smoke/data/small.txt", small_src.clone());
    let ub = tm.wait(&up_big).await.ok_or("missing transfer")?;
    let up_secs = t0.elapsed().as_secs_f64();
    let us = tm.wait(&up_small).await.ok_or("missing transfer")?;
    println!("  big upload: {:?} {:?} parts {}/{} in {:.2}s ({:.1} MiB/s)", ub.status, ub.error, ub.parts_done, ub.parts_total, up_secs, big_mib as f64 / up_secs);
    check(ub.status == TransferStatus::Completed, "big upload completed")?;
    check(ub.parts_total == parts && ub.parts_done == parts, "multipart used 8 MiB parts")?;
    check(ub.transferred_bytes == big.len() as u64, "upload transferredBytes")?;
    check(us.status == TransferStatus::Completed && us.parts_total == 1, "small upload completed (PutObject)")?;

    println!("list / head");
    let page = ops::list_objects(&client, bucket, "smoke/data/", None, None).await?;
    let names: Vec<_> = page.objects.iter().map(|o| (o.name.clone(), o.size)).collect();
    println!("  {names:?}");
    check(page.objects.len() == 2, "two objects listed")?;
    check(page.objects.iter().any(|o| o.name == "big.bin" && o.size == big.len() as u64), "big.bin size")?;
    // Page through with pageSize=2 (marker + 1 object per first page). pageSize=1 trips a
    // SeaweedFS quirk (marker-only page reported as not truncated).
    let (mut token, mut seen, mut pages) = (None, Vec::new(), 0);
    loop {
        let p = ops::list_objects(&client, bucket, "smoke/data/", token.clone(), Some(2)).await?;
        pages += 1;
        seen.extend(p.objects.into_iter().map(|o| o.key));
        if !p.is_truncated {
            break;
        }
        token = p.next_continuation_token;
        check(token.is_some(), "truncated page has continuation token")?;
    }
    println!("  paged {seen:?} in {pages} pages");
    check(seen.len() == 2 && pages >= 2, "continuation paging")?;
    let meta = ops::head_object(&client, bucket, "smoke/data/big.bin").await?;
    println!("  head = {}", serde_json::to_string(&meta)?);
    check(meta.size == big.len() as u64, "head size")?;
    let small_meta = ops::head_object(&client, bucket, "smoke/data/small.txt").await?;
    check(small_meta.content_type.as_deref() == Some("text/plain"), "content type guessed")?;
    let missing = ops::head_object(&client, bucket, "smoke/nope").await;
    check(matches!(&missing, Err(e) if e.code == ErrorCode::NoSuchKey), "head missing -> NoSuchKey")?;

    println!("download");
    let big_dst = dir.join("out").join("big-dst.bin");
    let _ = tokio::fs::remove_file(&big_dst).await;
    rec.count.store(0, Ordering::Relaxed);
    let t1 = Instant::now();
    let dl = tm.start_download(client.clone(), bucket, "smoke/data/big.bin", big_dst.clone())?;
    // A second download to the same destination while the first is active is rejected.
    let dup = tm.start_download(client.clone(), bucket, "smoke/data/big.bin", big_dst.clone());
    println!("  same-dest second download -> {:?}", dup.as_ref().map_err(|e| &e.message));
    check(matches!(&dup, Err(e) if e.code == ErrorCode::InvalidInput), "same-destination download rejected")?;
    let d = tm.wait(&dl).await.ok_or("missing transfer")?;
    let dl_secs = t1.elapsed().as_secs_f64();
    println!(
        "  big download: {:?} {:?} parts {}/{} in {:.2}s ({:.1} MiB/s), {} progress events",
        d.status, d.error, d.parts_done, d.parts_total, dl_secs, big_mib as f64 / dl_secs, rec.count.load(Ordering::Relaxed)
    );
    check(d.status == TransferStatus::Completed, "download completed")?;
    check(d.parts_total == parts, "ranged download used 8 MiB parts")?;
    let got = tokio::fs::read(&big_dst).await?;
    check(got.len() == big.len(), "downloaded size matches")?;
    check(sha(&got) == sha(&big), &format!("sha256 matches ({})", sha(&big)))?;
    check(!part_files_exist(&dir.join("out"))?, ".part file renamed")?;
    {
        let ev = rec.events.lock().map_err(|_| "poisoned")?;
        let mine: Vec<_> = ev.iter().filter(|t| t.id == dl).collect();
        let monotonic = mine.windows(2).all(|w| w[0].transferred_bytes <= w[1].transferred_bytes);
        check(mine.first().is_some_and(|t| t.status == TransferStatus::Queued), "first event queued")?;
        check(mine.iter().any(|t| t.status == TransferStatus::Running), "running event")?;
        check(mine.last().is_some_and(|t| t.status == TransferStatus::Completed && t.finished_at.is_some()), "last event completed")?;
        check(monotonic, "progress monotonic")?;
    }

    let small_dst = dir.join("out").join("small-dst.txt");
    let ds = tm.start_download(client.clone(), bucket, "smoke/data/small.txt", small_dst.clone())?;
    let ds = tm.wait(&ds).await.ok_or("missing transfer")?;
    check(ds.status == TransferStatus::Completed && tokio::fs::read(&small_dst).await? == small, "small download")?;

    // Cancel mid-flight.
    let cancel_dst = dir.join("out").join("cancelled.bin");
    let c = tm.start_download(client.clone(), bucket, "smoke/data/big.bin", cancel_dst.clone())?;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    tm.cancel(&c)?;
    let ct = tm.wait(&c).await.ok_or("missing transfer")?;
    println!("  cancel -> {:?} after {} bytes", ct.status, ct.transferred_bytes);
    check(ct.status == TransferStatus::Cancelled || ct.status == TransferStatus::Completed, "cancel honoured")?;
    check(!part_files_exist(&dir.join("out"))?, "no .part left behind")?;

    // Missing key fails cleanly.
    let f = tm.start_download(client.clone(), bucket, "smoke/missing.bin", dir.join("out").join("missing.bin"))?;
    let ft = tm.wait(&f).await.ok_or("missing transfer")?;
    println!("  missing -> {:?}: {:?}", ft.status, ft.error);
    check(ft.status == TransferStatus::Failed, "missing key download failed")?;
    check(tm.list().len() == 6, "list_transfers has all transfers")?;
    tm.remove(&f)?;
    check(tm.list().len() == 5, "remove_transfer")?;

    settings_checks(&client, bucket, &dir, &big, &big_src, big_mib).await?;

    println!("delete");
    {
        use futures::stream::{self, StreamExt};
        let puts: Vec<_> = stream::iter(0..2100)
            .map(|i| {
                let c = client.clone();
                async move { c.put_object().bucket(bucket).key(format!("smoke/many/k{i:05}")).send().await }
            })
            .buffer_unordered(32)
            .collect()
            .await;
        check(puts.iter().all(|r| r.is_ok()), "seeded 2100 extra objects")?;
    }
    let t2 = Instant::now();
    let del = delete_prefix(&client, bucket, "smoke/").await?;
    println!("  deleted {} errors {:?} in {:.2}s", del.done_items, del.errors, t2.elapsed().as_secs_f64());
    check(
        del.status == JobStatus::Completed && del.done_items == 2103 && del.errors.is_empty(),
        "deleted marker + 2 files + 2100 (3 batches)",
    )?;
    let after = ops::list_all_keys(&client, bucket, "smoke/").await?;
    check(after.is_empty(), "prefix empty after delete")?;

    let _ = tokio::fs::remove_dir_all(&dir).await;
    println!("ALL SMOKE CHECKS PASSED");
    Ok(())
}
