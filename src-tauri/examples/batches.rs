//! End-to-end tests for folder transfers (batches) against a local S3-compatible server.
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin), BATCHES_DIR (scratch dir, default `target/batches-test`
//! next to this crate), BATCHES_BIG_MIB (size of the one large file, default 40).
//!
//! Run: `cargo run --example batches`

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use futures::stream::{self, StreamExt};
use s3explorer_lib::batches::{self, BatchManager, BatchSink};
use s3explorer_lib::error::ErrorCode;
use s3explorer_lib::models::{
    Batch, BatchKind, BatchPlanRequest, BatchStatus, ConflictPolicy, ConnectionConfig, Transfer, TransferSettings,
    TransferStatus,
};
use s3explorer_lib::ops;
use s3explorer_lib::state::Connection;
use s3explorer_lib::transfers::{ProgressSink, TransferManager};
use sha2::{Digest, Sha256};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const BUCKET: &str = "batches-bucket";
const SMALL_FILES: usize = 2000;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
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

fn random_bytes(len: usize, mut seed: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(len + 8);
    seed |= 1;
    while v.len() < len {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        v.extend_from_slice(&seed.to_le_bytes());
    }
    v.truncate(len);
    v
}

#[derive(Default)]
struct Rec {
    transfers: Mutex<Vec<Transfer>>,
    batches: Mutex<Vec<(Instant, Batch)>>,
}
struct TSink(Arc<Rec>);
impl ProgressSink for TSink {
    fn emit(&self, t: &Transfer) {
        self.0.transfers.lock().unwrap().push(t.clone());
    }
}
struct BSink(Arc<Rec>);
impl BatchSink for BSink {
    fn emit(&self, b: &Batch) {
        self.0.batches.lock().unwrap().push((Instant::now(), b.clone()));
    }
}

struct T {
    client: aws_sdk_s3::Client,
    rec: Arc<Rec>,
    tm: Arc<TransferManager>,
    bm: Arc<BatchManager>,
}

impl T {
    fn req(kind: BatchKind, prefix: &str, local: &Path, on_conflict: ConflictPolicy) -> BatchPlanRequest {
        BatchPlanRequest {
            kind,
            bucket: BUCKET.into(),
            prefix: prefix.into(),
            local_path: local.display().to_string(),
            on_conflict,
        }
    }

    async fn run(&self, req: BatchPlanRequest) -> Res<Batch> {
        let id = self.bm.start(req, self.client.clone())?;
        let b = tokio::time::timeout(Duration::from_secs(600), self.bm.wait(&id)).await?.ok_or("unknown batch")?;
        Ok(b)
    }

    fn events(&self, id: &str) -> Vec<(Instant, Batch)> {
        self.rec.batches.lock().unwrap().iter().filter(|(_, b)| b.id == id).cloned().collect()
    }

    fn set_limit(&self, n: u32) {
        let s = TransferSettings { max_concurrent_transfers: n, ..self.tm.settings() };
        self.tm.apply_settings(&s);
    }
}

/// Every check on a batch's event stream: first `planning`, statuses only move forward, the
/// last event is final and carries `finishedAt`, counters never go down, and events without a
/// status change are at least ~100 ms apart.
fn check_events(t: &T, b: &Batch) -> Res<()> {
    let ev = t.events(&b.id);
    let rank = |s: BatchStatus| match s {
        BatchStatus::Planning => 0,
        BatchStatus::Queued => 1,
        BatchStatus::Running => 2,
        _ => 3,
    };
    check(ev.first().is_some_and(|(_, e)| e.status == BatchStatus::Planning), "events: first is planning")?;
    check(ev.windows(2).all(|w| rank(w[0].1.status) <= rank(w[1].1.status)), "events: phases in order")?;
    let last = &ev.last().ok_or("no events")?.1;
    check(last.status == b.status && last.finished_at.is_some(), "events: last is final with finishedAt")?;
    check(ev.iter().filter(|(_, e)| e.finished_at.is_some()).count() == 1, "events: exactly one final event")?;
    let mono = ev.windows(2).all(|w| {
        let (a, c) = (&w[0].1, &w[1].1);
        a.done_files <= c.done_files
            && a.skipped_files <= c.skipped_files
            && a.failed_files <= c.failed_files
            && a.done_bytes <= c.done_bytes
            && a.errors.len() <= c.errors.len()
    });
    check(mono, "events: counters monotonic")?;
    let throttled = ev.windows(2).all(|w| {
        w[0].1.status != w[1].1.status
            || w[1].1.finished_at.is_some()
            || w[1].0.duration_since(w[0].0) >= Duration::from_millis(95)
    });
    let statuses: Vec<BatchStatus> = ev.iter().map(|(_, e)| e.status).collect::<Vec<_>>();
    let mut distinct = statuses.clone();
    distinct.dedup();
    println!("  {} events, statuses {:?}", ev.len(), distinct);
    check(throttled, "events: throttled to 100 ms within a status")?;
    Ok(())
}

/// All files under `dir`: relative path (with `/`) -> sha256.
fn local_tree(dir: &Path) -> Res<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d)? {
            let e = e?;
            let ft = e.file_type()?;
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(e.path());
            } else {
                let rel = e.path().strip_prefix(dir)?.iter().map(|c| c.to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
                out.insert(rel, sha(&std::fs::read(e.path())?));
            }
        }
    }
    Ok(out)
}

fn part_files(dir: &Path) -> usize {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(e.path());
            } else if e.file_name().to_string_lossy().ends_with(".part") {
                n += 1;
            }
        }
    }
    n
}

fn mtimes(dir: &Path, rels: &[&String]) -> Res<Vec<SystemTime>> {
    rels.iter().map(|r| Ok(std::fs::metadata(dir.join(r.as_str()))?.modified()?)).collect()
}

fn set_old_mtimes(dir: &Path, rels: &[&String]) -> Res<SystemTime> {
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    for r in rels {
        std::fs::File::options().write(true).open(dir.join(r.as_str()))?.set_modified(old)?;
    }
    Ok(old)
}

/// key -> sha256 of every object under `prefix`.
async fn bucket_tree(client: &aws_sdk_s3::Client, prefix: &str) -> Res<BTreeMap<String, String>> {
    let keys = ops::list_all_keys(client, BUCKET, prefix).await?;
    let got: Vec<Result<(String, String), String>> = stream::iter(keys)
        .map(|k| {
            let c = client.clone();
            async move {
                let o = c.get_object().bucket(BUCKET).key(&k).send().await.map_err(|e| format!("{k}: {e}"))?;
                let body = o.body.collect().await.map_err(|e| format!("{k}: {e}"))?.into_bytes();
                Ok((k, sha(&body)))
            }
        })
        .buffer_unordered(32)
        .collect()
        .await;
    let mut out = BTreeMap::new();
    for g in got {
        let (k, h) = g?;
        out.insert(k, h);
    }
    Ok(out)
}

async fn delete_prefix(client: &aws_sdk_s3::Client, prefix: &str) -> Res<()> {
    let keys = ops::list_all_keys(client, BUCKET, prefix).await?;
    for chunk in keys.chunks(1000) {
        let objs: Vec<_> = chunk
            .iter()
            .map(|k| aws_sdk_s3::types::ObjectIdentifier::builder().key(k).build())
            .collect::<Result<_, _>>()?;
        client
            .delete_objects()
            .bucket(BUCKET)
            .delete(aws_sdk_s3::types::Delete::builder().set_objects(Some(objs)).build()?)
            .send()
            .await?;
    }
    Ok(())
}

/// Builds the source tree; returns relative path -> sha256 of every readable regular file, and
/// a guard that keeps one file unreadable while it lives.
fn build_tree(src: &Path, big_mib: usize) -> Res<(BTreeMap<String, String>, Option<std::fs::File>, bool)> {
    let _ = std::fs::remove_dir_all(src);
    std::fs::create_dir_all(src)?;
    let mut expected = BTreeMap::new();
    let mut put = |rel: &str, data: &[u8]| -> Res<()> {
        let p = src.join(rel);
        std::fs::create_dir_all(p.parent().ok_or("no parent")?)?;
        std::fs::write(&p, data)?;
        expected.insert(rel.to_string(), sha(data));
        Ok(())
    };
    for i in 0..SMALL_FILES {
        let rel = format!("dir{:02}/sub{}/file {i:04}.txt", i % 20, (i / 20) % 3);
        put(&rel, &random_bytes(1 + (i * 37) % 4096, i as u64 + 7))?;
    }
    put("big.bin", &random_bytes(big_mib * 1024 * 1024, 0xB16))?;
    put("my folder/été naïve 📷.txt", "unicode and spaces".as_bytes())?;
    put("日本語/ファイル.txt", "japanese".as_bytes())?;
    put("a/b/c/d/deep.txt", b"deep")?;
    put(".hidden", b"hidden file")?;
    std::fs::create_dir_all(src.join("empty-dir"))?;
    // A file that cannot be read during planning.
    let locked = src.join("locked.bin");
    std::fs::write(&locked, b"locked")?;
    #[cfg(windows)]
    let guard = {
        use std::os::windows::fs::OpenOptionsExt;
        Some(std::fs::OpenOptions::new().read(true).share_mode(0).open(&locked)?)
    };
    #[cfg(unix)]
    let guard = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))?;
        None
    };
    // A link to a folder (symlink, or a junction on Windows without symlink rights).
    let link = src.join("link-to-dir00");
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(src.join("dir00"), &link).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(src.join("dir00"), &link).is_ok()
        || std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(src.join("dir00"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    Ok((expected, guard, linked))
}

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let ak = env("SMOKE_ACCESS_KEY", "minioadmin");
    let sk = env("SMOKE_SECRET_KEY", "minioadmin");
    let default_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("batches-test");
    let dir = PathBuf::from(env("BATCHES_DIR", &default_dir.to_string_lossy()));
    let big_mib: usize = env("BATCHES_BIG_MIB", "40").parse()?;
    std::fs::create_dir_all(&dir)?;

    let conn = Connection::open(ConnectionConfig::Static {
        access_key_id: ak,
        secret_access_key: sk,
        session_token: None,
        region: "us-east-1".into(),
        endpoint: Some(endpoint),
        force_path_style: None,
    })
    .await?;
    let client = conn.client_for_bucket(BUCKET).await;
    let _ = client.create_bucket().bucket(BUCKET).send().await;
    delete_prefix(&client, "batches/").await?;

    let rec = Arc::new(Rec::default());
    let tm = TransferManager::with_settings(Arc::new(TSink(rec.clone())), TransferSettings::default());
    let bm = BatchManager::new(tm.clone(), Arc::new(BSink(rec.clone())));
    let t = T { client: client.clone(), rec: rec.clone(), tm: tm.clone(), bm: bm.clone() };

    // ---------------------------------------------------------------- upload
    println!("upload: build the local tree");
    let src = dir.join("src");
    let (expected, guard, linked) = build_tree(&src, big_mib)?;
    let n = expected.len() as u64;
    println!("  {} readable files, 1 locked, link created: {linked}", n);

    let up_prefix = "batches/up/";
    let preview = batches::preview(&T::req(BatchKind::Upload, up_prefix, &src, ConflictPolicy::Skip), &client).await?;
    println!("  preview: files {} bytes {} conflicts {} unreadable {} notes {:?}", preview.files, preview.bytes, preview.conflicts, preview.skipped_unreadable, preview.notes);
    check(preview.files == n && preview.conflicts == 0 && !preview.truncated, "preview counts every readable file")?;
    check(preview.skipped_unreadable == 1, "preview: one unreadable file")?;
    check(preview.notes.iter().any(|x| x.contains("locked.bin")), "preview notes name the unreadable file")?;
    if linked {
        check(preview.notes.iter().any(|x| x.starts_with("Skipped symbolic link") && x.contains("link-to-dir00")), "preview notes the skipped link")?;
    }
    check(ops::list_all_keys(&client, BUCKET, up_prefix).await?.is_empty(), "preview changed nothing")?;

    let t0 = Instant::now();
    let b = t.run(T::req(BatchKind::Upload, up_prefix, &src, ConflictPolicy::Skip)).await?;
    let secs = t0.elapsed().as_secs_f64();
    println!(
        "  upload batch: {:?} total {} done {} skipped {} failed {} bytes {}/{} in {secs:.1}s, label {:?}, errors {:?}",
        b.status, b.total_files, b.done_files, b.skipped_files, b.failed_files, b.done_bytes, b.total_bytes, b.label, b.errors
    );
    check(b.done_files == n && b.failed_files == 1 && b.skipped_files == 0 && b.total_files == n + 1, "upload counters")?;
    check(b.status == BatchStatus::Failed, "an unreadable file makes the batch failed")?;
    check(b.errors.len() == 1 && b.errors[0].path.ends_with("locked.bin"), "the failure names the local path")?;
    check(b.done_bytes == b.total_bytes && b.total_bytes == preview.bytes, "doneBytes == totalBytes")?;
    check(b.label.starts_with("Upload src/ (") && b.label.contains("files)"), "label")?;
    check_events(&t, &b)?;
    let in_bucket = bucket_tree(&client, up_prefix).await?;
    let want: BTreeMap<String, String> = expected.iter().map(|(k, v)| (format!("{up_prefix}{k}"), v.clone())).collect();
    check(in_bucket == want, &format!("every key present with matching sha256 ({} keys)", want.len()))?;
    check(!in_bucket.contains_key(up_prefix), "no folder marker created")?;
    check(!in_bucket.keys().any(|k| k.contains("empty-dir")), "empty folder not created")?;
    check(!in_bucket.keys().any(|k| k.contains("link-to-dir00") || k.contains("locked.bin")), "link and unreadable not uploaded")?;
    let ids = bm.transfer_ids(&b.id);
    let tr: Vec<Transfer> = ids.iter().filter_map(|id| tm.get(id)).collect();
    check(tr.len() as u64 == n && tr.iter().all(|x| x.batch_id.as_deref() == Some(b.id.as_str())), "every transfer carries batchId")?;
    let keys_in_order: Vec<&str> = tr.iter().map(|x| x.key.as_str()).collect();
    let mut sorted = keys_in_order.clone();
    sorted.sort();
    check(keys_in_order == sorted, "files started in path order")?;

    println!("upload again with skip");
    let p2 = batches::preview(&T::req(BatchKind::Upload, up_prefix, &src, ConflictPolicy::Skip), &client).await?;
    check(p2.conflicts == n && p2.files == n, "preview: files counts every file, conflicts is the subset")?;
    let p3 = batches::preview(&T::req(BatchKind::Upload, up_prefix, &src, ConflictPolicy::Overwrite), &client).await?;
    check(p3.files == n && p3.conflicts == n && p3.bytes == p2.bytes, "preview does not depend on onConflict")?;
    let b2 = t.run(T::req(BatchKind::Upload, up_prefix, &src, ConflictPolicy::Skip)).await?;
    println!("  {:?} done {} skipped {} failed {}", b2.status, b2.done_files, b2.skipped_files, b2.failed_files);
    check(b2.skipped_files == n && b2.done_files == 0 && b2.failed_files == 1, "all skipped")?;
    check(bm.transfer_ids(&b2.id).is_empty(), "no transfer started")?;
    check_events(&t, &b2)?;

    println!("upload with overwrite (one file changed locally)");
    let changed = "dir00/sub0/file 0000.txt";
    std::fs::write(src.join(changed), b"changed content")?;
    let b3 = t.run(T::req(BatchKind::Upload, up_prefix, &src, ConflictPolicy::Overwrite)).await?;
    check(b3.done_files == n && b3.skipped_files == 0, "overwrite sends every file")?;
    let after = bucket_tree(&client, up_prefix).await?;
    check(after.get(&format!("{up_prefix}{changed}")) == Some(&sha(b"changed content")), "changed file overwritten")?;
    let mut expected = expected;
    expected.insert(changed.to_string(), sha(b"changed content"));
    drop(guard);

    // ---------------------------------------------------------------- download
    println!("download to an empty folder");
    let dl = dir.join("dl1");
    let _ = std::fs::remove_dir_all(&dl);
    let pd = batches::preview(&T::req(BatchKind::Download, up_prefix, &dl, ConflictPolicy::Skip), &client).await?;
    check(pd.files == n && pd.conflicts == 0, "download preview")?;
    check(!dl.exists(), "download preview created nothing")?;
    let t0 = Instant::now();
    let d = t.run(T::req(BatchKind::Download, up_prefix, &dl, ConflictPolicy::Skip)).await?;
    println!("  {:?} done {} in {:.1}s, label {:?}", d.status, d.done_files, t0.elapsed().as_secs_f64(), d.label);
    check(d.status == BatchStatus::Completed && d.done_files == n && d.total_files == n, "download completed")?;
    check(d.label == format!("Download up/ to {}", dl.display()), "download label")?;
    check(local_tree(&dl)? == expected, "every file byte-identical, tree recreated")?;
    check(part_files(&dl) == 0, "no .part files")?;
    check_events(&t, &d)?;

    println!("download again with skip");
    let rels: Vec<&String> = expected.keys().collect();
    let old = set_old_mtimes(&dl, &rels)?;
    let d2 = t.run(T::req(BatchKind::Download, up_prefix, &dl, ConflictPolicy::Skip)).await?;
    println!("  {:?} done {} skipped {}", d2.status, d2.done_files, d2.skipped_files);
    check(d2.status == BatchStatus::Completed && d2.skipped_files == n && d2.done_files == 0, "all skipped")?;
    check(mtimes(&dl, &rels)?.iter().all(|m| *m == old), "nothing rewritten (mtimes unchanged)")?;
    check_events(&t, &d2)?;

    println!("download again with overwrite");
    let d3 = t.run(T::req(BatchKind::Download, up_prefix, &dl, ConflictPolicy::Overwrite)).await?;
    check(d3.status == BatchStatus::Completed && d3.done_files == n, "overwrite downloads every file")?;
    check(mtimes(&dl, &rels)?.iter().all(|m| *m > old), "every file rewritten")?;
    check(local_tree(&dl)? == expected, "still byte-identical")?;

    println!("keys that collide locally");
    let coll = "batches/coll/";
    for (k, body) in [("A.txt", "upper"), ("a.txt", "lower"), ("x:y.txt", "colon"), ("x_y.txt", "underscore"), ("CON", "device"), ("sp ace .txt ", "trailing")] {
        client.put_object().bucket(BUCKET).key(format!("{coll}{k}")).body(body.as_bytes().to_vec().into()).send().await?;
    }
    let cdir = dir.join("coll");
    let _ = std::fs::remove_dir_all(&cdir);
    let c = t.run(T::req(BatchKind::Download, coll, &cdir, ConflictPolicy::Overwrite)).await?;
    println!("  {:?} done {} failed {} errors {:#?}", c.status, c.done_files, c.failed_files, c.errors);
    let local = local_tree(&cdir)?;
    println!("  local files: {:?}", local.keys().collect::<Vec<_>>());
    let case_insensitive = cfg!(any(windows, target_os = "macos"));
    let want_failed = if case_insensitive { 2 } else { 1 };
    check(c.failed_files == want_failed && c.done_files == 6 - want_failed, "colliding keys: one wins, the other is a per-file failure")?;
    check(c.status == BatchStatus::Failed, "batch with a collision ends failed")?;
    check(local.get("A.txt") == Some(&sha(b"upper")), "first key kept, never silently overwritten")?;
    check(local.get("x_y.txt") == Some(&sha(b"colon")), "x:y.txt -> x_y.txt; x_y.txt refused")?;
    check(c.errors.iter().any(|e| e.path == format!("{coll}x_y.txt") && e.message.contains("x:y.txt")), "error names both keys")?;
    if case_insensitive {
        check(c.errors.iter().any(|e| e.path == format!("{coll}a.txt") && e.message.contains("A.txt")), "a.txt refused (case)")?;
    }
    check(local.get("_CON") == Some(&sha(b"device")), "reserved name CON -> _CON")?;
    check(local.contains_key("sp ace .txt"), "trailing space removed")?;

    // ---------------------------------------------------------------- cancel
    println!("cancel a download mid-batch");
    t.set_limit(1);
    let cdl = dir.join("dl-cancel");
    let _ = std::fs::remove_dir_all(&cdl);
    let id = bm.start(T::req(BatchKind::Download, up_prefix, &cdl, ConflictPolicy::Skip), client.clone())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while bm.get(&id).map(|b| b.done_files).unwrap_or(0) < 100 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    bm.cancel(&id)?;
    let x = tokio::time::timeout(Duration::from_secs(60), bm.wait(&id)).await?.ok_or("unknown")?;
    let local = local_tree(&cdl)?;
    println!("  {:?} done {} skipped {} failed {} of {}; {} local files", x.status, x.done_files, x.skipped_files, x.failed_files, x.total_files, local.len());
    check(x.status == BatchStatus::Cancelled, "cancelled")?;
    check(x.done_files >= 100 && x.done_files < n, "stopped part way")?;
    check(x.done_files + x.skipped_files + x.failed_files <= x.total_files && x.failed_files == 0, "counters consistent")?;
    check(local.len() as u64 == x.done_files, "local files == doneFiles")?;
    check(local.iter().all(|(k, h)| expected.get(k) == Some(h)), "finished files intact")?;
    check(part_files(&cdl) == 0, "no .part left")?;
    check(bm.transfer_ids(&id).iter().all(|i| tm.get(i).is_some_and(|t| !t.status.is_active())), "no transfer of the batch still active")?;
    check(!tm.has_active() && tm.running_count() == 0 && !bm.has_active(), "nothing active, no slot held")?;
    check_events(&t, &x)?;
    let tids = bm.transfer_ids(&id);
    check(!tids.is_empty() && tids.iter().all(|i| tm.get(i).is_some()), "the batch's transfers are listed until removed")?;
    check(bm.remove(&id).is_ok() && bm.get(&id).is_none(), "remove_batch")?;
    check(tids.iter().all(|i| tm.get(i).is_none()) && !tm.list().iter().any(|x| x.batch_id.as_deref() == Some(id.as_str())), "removed with its transfers")?;
    check(tm.list().iter().filter(|x| x.batch_id.is_none()).count() == 0, "no single transfers in this run, so no null batchId either")?;

    println!("cancel an upload mid-batch");
    let cup = "batches/up-cancel/";
    let id = bm.start(T::req(BatchKind::Upload, cup, &src, ConflictPolicy::Skip), client.clone())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while bm.get(&id).map(|b| b.done_files).unwrap_or(0) < 30 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    check(bm.remove(&id).is_err_and(|e| e.code == ErrorCode::InvalidInput), "remove refused while running")?;
    bm.cancel(&id)?;
    let x = tokio::time::timeout(Duration::from_secs(60), bm.wait(&id)).await?.ok_or("unknown")?;
    let keys = ops::list_all_keys(&client, BUCKET, cup).await?;
    println!("  {:?} done {} of {}; {} keys", x.status, x.done_files, x.total_files, keys.len());
    // A PutObject that the server completes just as the cancel arrives is stored but reported
    // cancelled (as for a single upload): at most one such file per running slot (limit 1 here),
    // always complete (checked by hash below), never partial.
    check(x.status == BatchStatus::Cancelled, "cancelled")?;
    check(keys.len() as u64 >= x.done_files && keys.len() as u64 <= x.done_files + 1, "uploaded keys == doneFiles (+1 in flight at the cancel)")?;
    let up = bucket_tree(&client, cup).await?;
    check(up.iter().all(|(k, h)| expected.get(&k[cup.len()..]) == Some(h)), "uploaded files intact")?;

    // ---------------------------------------------------------------- limit 1
    println!("a 3-file batch with maxConcurrentTransfers = 1");
    let three = dir.join("three");
    let _ = std::fs::remove_dir_all(&three);
    std::fs::create_dir_all(&three)?;
    std::fs::write(three.join("1.bin"), random_bytes(12 * 1024 * 1024, 1))?;
    std::fs::write(three.join("2.bin"), random_bytes(12 * 1024 * 1024, 2))?;
    std::fs::write(three.join("3.txt"), b"three")?;
    let b = t.run(T::req(BatchKind::Upload, "batches/three/", &three, ConflictPolicy::Overwrite)).await?;
    let ids = bm.transfer_ids(&b.id);
    let ev: Vec<Transfer> = rec.transfers.lock().unwrap().iter().filter(|x| ids.contains(&x.id)).cloned().collect();
    let mut status: HashMap<&str, TransferStatus> = HashMap::new();
    let mut max = 0;
    for e in &ev {
        status.insert(&e.id, e.status);
        max = max.max(status.values().filter(|s| **s == TransferStatus::Running).count());
    }
    println!("  {:?} done {}, max running {max}", b.status, b.done_files);
    check(b.status == BatchStatus::Completed && b.done_files == 3, "3 files uploaded")?;
    check(max == 1, "never more than 1 running")?;
    check(b.done_bytes == 24 * 1024 * 1024 + 5, "doneBytes")?;
    check_events(&t, &b)?;
    t.set_limit(4);

    // ---------------------------------------------------------------- planning failures
    println!("planning failures");
    let before = tm.list().len();
    let f = t.run(T::req(BatchKind::Upload, "batches/x/", &dir.join("does-not-exist"), ConflictPolicy::Skip)).await?;
    println!("  missing folder -> {:?}: {:?}", f.status, f.error);
    check(f.status == BatchStatus::Failed && f.error.is_some() && tm.list().len() == before, "missing folder fails before any transfer")?;
    check_events(&t, &f)?;
    let mut r = T::req(BatchKind::Download, "batches/up/", &dir.join("nb"), ConflictPolicy::Skip);
    r.bucket = "no-such-bucket-batches".into();
    let id = bm.start(r, client.clone())?;
    let f = bm.wait(&id).await.ok_or("unknown")?;
    println!("  missing bucket -> {:?}: {:?}", f.status, f.error);
    check(f.status == BatchStatus::Failed && tm.list().len() == before && !dir.join("nb").exists(), "listing failure fails the batch")?;
    // The UI tells a dropped file from a dropped folder by this: a plain file is InvalidInput,
    // answered before any S3 request; a missing folder is Io.
    let file = dir.join("plain-file.txt");
    std::fs::write(&file, b"x")?;
    let t0 = Instant::now();
    let e = batches::preview(&T::req(BatchKind::Upload, "batches/x/", &file, ConflictPolicy::Skip), &client).await;
    println!("  preview of a file -> {:?} in {:?}", e.as_ref().err(), t0.elapsed());
    check(e.is_err_and(|e| e.code == ErrorCode::InvalidInput) && t0.elapsed() < Duration::from_millis(500), "preview of a plain file: quick InvalidInput")?;
    let e = batches::preview(&T::req(BatchKind::Upload, "batches/x/", &dir.join("does-not-exist"), ConflictPolicy::Skip), &client).await;
    println!("  preview of a missing folder -> {:?}", e.as_ref().err());
    check(e.is_err_and(|e| e.code == ErrorCode::Io), "preview of a missing folder: Io")?;
    // A download into a folder that does not exist yet (several levels) creates it.
    let nested = dir.join("multi").join("logs");
    let d = t.run(T::req(BatchKind::Download, "batches/three/", &nested, ConflictPolicy::Skip)).await?;
    check(d.status == BatchStatus::Completed && d.done_files == 3 && nested.join("3.txt").is_file(), "download creates the missing local folder and its parents")?;
    let bad = bm.start(T::req(BatchKind::Download, "no-slash", &dir, ConflictPolicy::Skip), client.clone());
    check(bad.is_err_and(|e| e.code == ErrorCode::InvalidInput), "invalid request rejected synchronously")?;

    // ---------------------------------------------------------------- clean up
    delete_prefix(&client, "batches/").await?;
    let _ = std::fs::remove_dir_all(&dir);
    println!("ALL BATCH CHECKS PASSED");
    Ok(())
}
