//! End-to-end smoke test against a local S3-compatible server (no Tauri involved).
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin), SMOKE_DIR (scratch dir for files, default temp dir).
//!
//! Run: `cargo run --example smoke`

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use s3explorer_lib::error::ErrorCode;
use s3explorer_lib::models::{ConnectionConfig, Transfer, TransferStatus};
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
    ops::delete_folder(&client, bucket, "smoke/").await?;

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
    let del = ops::delete_folder(&client, bucket, "smoke/").await?;
    println!("  deleted {} errors {:?} in {:.2}s", del.deleted, del.errors, t2.elapsed().as_secs_f64());
    check(del.deleted == 2103 && del.errors.is_empty(), "deleted marker + 2 files + 2100 (3 batches)")?;
    let after = ops::list_all_keys(&client, bucket, "smoke/").await?;
    check(after.is_empty(), "prefix empty after delete")?;

    let _ = tokio::fs::remove_dir_all(&dir).await;
    println!("ALL SMOKE CHECKS PASSED");
    Ok(())
}
