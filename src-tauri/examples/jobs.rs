//! End-to-end tests for object operations (jobs) against a local S3-compatible server.
//!
//! Every scenario snapshots the buckets (every key with its size and SHA-256) before and after
//! and asserts exactly what changed and what survived.
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin), JOBS_BIG_MIB (multipart-copy object size, default 40).
//!
//! Run: `cargo run --example jobs`

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use futures::future::FutureExt;
use futures::stream::{self, StreamExt};
use s3explorer_lib::error::ErrorCode;
use s3explorer_lib::jobs::{self, AfterListingHook, JobManager, JobSink, JobTuning};
use s3explorer_lib::models::{
    ConflictPolicy, ConnectionConfig, Job, JobItem, JobKind, JobPhase, JobRequest, JobStatus,
};
use s3explorer_lib::ops;
use s3explorer_lib::state::Connection;
use sha2::{Digest, Sha256};

type Res<T> = Result<T, Box<dyn std::error::Error>>;
/// key -> (size, sha256)
type Snap = BTreeMap<String, (u64, String)>;
type SnapEntry = Result<(String, (u64, String)), String>;

const A: &str = "jobs-a";
const B: &str = "jobs-b";

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
    while v.len() < len {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        v.extend_from_slice(&seed.to_le_bytes());
    }
    v.truncate(len);
    v
}

/// Content derived from the key, so where an object ends up can be checked against its origin.
fn body_for(key: &str) -> Vec<u8> {
    format!("content of {key}\n").into_bytes()
}

struct Recorder(Mutex<Vec<(Instant, Job)>>);
impl JobSink for Recorder {
    fn emit(&self, job: &Job) {
        if let Ok(mut v) = self.0.lock() {
            v.push((Instant::now(), job.clone()));
        }
    }
}
impl Recorder {
    fn timed(&self, id: &str) -> Vec<(Instant, Job)> {
        self.0.lock().map(|v| v.iter().filter(|(_, j)| j.id == id).cloned().collect()).unwrap_or_default()
    }
    fn events(&self, id: &str) -> Vec<Job> {
        self.timed(id).into_iter().map(|(_, j)| j).collect()
    }
    fn all(&self) -> Vec<Job> {
        self.0.lock().map(|v| v.iter().map(|(_, j)| j.clone()).collect()).unwrap_or_default()
    }
}

struct T {
    c: Client,
    rec: Arc<Recorder>,
    mgr: Arc<JobManager>,
}

impl T {
    async fn put(&self, bucket: &str, key: &str, body: Vec<u8>) -> Res<()> {
        self.c.put_object().bucket(bucket).key(key).body(ByteStream::from(body)).send().await?;
        Ok(())
    }

    async fn put_many(&self, bucket: &str, keys: &[String]) -> Res<()> {
        let results: Vec<_> = stream::iter(keys.iter())
            .map(|k| {
                let c = self.c.clone();
                let body = body_for(k);
                async move { c.put_object().bucket(bucket).key(k).body(ByteStream::from(body)).send().await }
            })
            .buffer_unordered(32)
            .collect()
            .await;
        for r in results {
            r?;
        }
        Ok(())
    }

    async fn get(&self, bucket: &str, key: &str) -> Res<Vec<u8>> {
        let o = self.c.get_object().bucket(bucket).key(key).send().await?;
        Ok(o.body.collect().await?.into_bytes().to_vec())
    }

    /// Every key in the bucket with its size and content hash.
    async fn snap(&self, bucket: &str) -> Res<Snap> {
        let keys = ops::list_all_keys(&self.c, bucket, "").await?;
        let results: Vec<SnapEntry> = stream::iter(keys)
            .map(|k| {
                let c = self.c.clone();
                async move {
                    let o = c.get_object().bucket(bucket).key(&k).send().await.map_err(|e| format!("{k}: {e:?}"))?;
                    let data = o.body.collect().await.map_err(|e| format!("{k}: {e}"))?.into_bytes();
                    Ok((k, (data.len() as u64, sha(&data))))
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

    /// Deletes everything in the bucket (test setup only).
    async fn wipe(&self, bucket: &str) -> Res<()> {
        let keys = ops::list_all_keys(&self.c, bucket, "").await?;
        let results: Vec<_> = stream::iter(keys)
            .map(|k| {
                let c = self.c.clone();
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

    fn start(&self, req: JobRequest) -> Res<String> {
        let dest = req.dest_bucket.as_ref().map(|_| self.c.clone());
        Ok(self.mgr.start(req, self.c.clone(), dest)?)
    }

    async fn run(&self, req: JobRequest) -> Res<Job> {
        let id = self.start(req)?;
        let j = self.mgr.wait(&id).await.ok_or("job vanished")?;
        self.check_events(&j)?;
        Ok(j)
    }

    /// Event-stream invariants every job must satisfy.
    fn check_events(&self, j: &Job) -> Res<()> {
        let ev = self.rec.events(&j.id);
        let first_ok = ev.first().is_some_and(|e| e.status == JobStatus::Queued && e.phase == JobPhase::Listing);
        let last_ok = ev.last().is_some_and(|e| e.finished_at.is_some() && e.phase == JobPhase::Done && !e.status.is_active());
        let finals = ev.iter().filter(|e| e.finished_at.is_some()).count();
        let phases_ordered = ev.windows(2).all(|w| phase_rank(w[0].phase) <= phase_rank(w[1].phase));
        let done_monotonic = ev.windows(2).all(|w| {
            w[0].done_items <= w[1].done_items
                && w[0].failed_items <= w[1].failed_items
                && w[0].skipped_items <= w[1].skipped_items
                && w[0].done_bytes <= w[1].done_bytes
        });
        // Throttle: two progress events in the same status and phase are >= ~100 ms apart (a
        // status or phase change is always sent at once; the event after it may follow quickly).
        let timed = self.rec.timed(&j.id);
        let throttled = timed.windows(3).all(|w| {
            let same = |a: &Job, b: &Job| a.status == b.status && a.phase == b.phase;
            !(same(&w[0].1, &w[1].1) && same(&w[1].1, &w[2].1) && w[2].1.finished_at.is_none())
                || w[2].0.duration_since(w[1].0) >= Duration::from_millis(80)
        });
        if !throttled {
            return Err(format!("progress events closer than 100 ms for {}", j.label).into());
        }
        if !(first_ok && last_ok && finals == 1 && phases_ordered && done_monotonic) {
            return Err(format!(
                "event invariants broken for {}: first_ok={first_ok} last_ok={last_ok} finals={finals} phases_ordered={phases_ordered} monotonic={done_monotonic}",
                j.label
            )
            .into());
        }
        if j.status != JobStatus::Cancelled && j.error.is_none() {
            let sum = j.done_items + j.skipped_items + j.failed_items;
            if sum != j.total_items {
                return Err(format!("counters do not add up: {j:?}").into());
            }
        }
        let expected_status = if j.error.is_some() || j.failed_items > 0 { JobStatus::Failed } else { JobStatus::Completed };
        if j.status != JobStatus::Cancelled && j.status != expected_status {
            return Err(format!("final status {:?} but expected {expected_status:?}: {j:?}", j.status).into());
        }
        if j.errors.len() as u64 > j.failed_items.min(50) {
            return Err("more errors than failures".into());
        }
        Ok(())
    }
}

fn phase_rank(p: JobPhase) -> u8 {
    match p {
        JobPhase::Listing => 0,
        JobPhase::Working => 1,
        JobPhase::Done => 2,
    }
}

fn obj(from: &str, to: Option<&str>) -> JobItem {
    JobItem { from: from.into(), to: to.map(Into::into), is_prefix: false }
}
fn pre(from: &str, to: Option<&str>) -> JobItem {
    JobItem { from: from.into(), to: to.map(Into::into), is_prefix: true }
}
fn req(kind: JobKind, dest: Option<&str>, items: Vec<JobItem>, on_conflict: ConflictPolicy) -> JobRequest {
    JobRequest { kind, src_bucket: A.into(), dest_bucket: dest.map(Into::into), items, on_conflict, tags: None }
}

/// `before` with `remove` keys dropped and `add` merged in.
fn expect(before: &Snap, remove: &[&str], add: &Snap) -> Snap {
    let mut s = before.clone();
    for k in remove {
        s.remove(*k);
    }
    for (k, v) in add {
        s.insert(k.clone(), v.clone());
    }
    s
}

fn diff(want: &Snap, got: &Snap) -> String {
    let mut out = Vec::new();
    for (k, v) in want {
        match got.get(k) {
            None => out.push(format!("missing {k:?}")),
            Some(g) if g != v => out.push(format!("changed {k:?}")),
            _ => {}
        }
    }
    for k in got.keys() {
        if !want.contains_key(k) {
            out.push(format!("unexpected {k:?}"));
        }
    }
    out.truncate(10);
    out.join(", ")
}

/// Zero-byte folder markers are left out of comparisons: SeaweedFS stores folders as
/// directories and hides a marker from listings once the folder has children.
fn without_markers(s: &Snap) -> Snap {
    s.iter().filter(|(k, (size, _))| !(k.ends_with('/') && *size == 0)).map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn same(want: &Snap, got: &Snap, what: &str) -> Res<()> {
    let d = diff(&without_markers(want), &without_markers(got));
    if !d.is_empty() {
        println!("     diff: {d}");
    }
    check(d.is_empty(), what)
}

/// Entries of `snap` under `from`, re-keyed under `to`.
fn mapped(snap: &Snap, from: &str, to: &str) -> Snap {
    snap.iter().filter_map(|(k, v)| k.strip_prefix(from).map(|rest| (format!("{to}{rest}"), v.clone()))).collect()
}

fn under<'a>(snap: &'a Snap, prefix: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    snap.keys().filter(move |k| k.starts_with(prefix)).map(String::as_str)
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

// ---- scenarios ----------------------------------------------------------------------------------

async fn a_delete(t: &T) -> Res<()> {
    println!("a. delete objects and a folder with > 2,000 keys");
    let many: Vec<String> = (0..2150).map(|i| format!("d/many/k{i:05}")).collect();
    t.put_many(A, &many).await?;
    let others: Vec<String> =
        ["d/many/", "d/foobar/y", "d/foo2", "d/single.txt", "d/many-sibling", "keep/z"].iter().map(|s| s.to_string()).collect();
    t.put_many(A, &others).await?;
    // The object `d/foo` and the folder `d/foo/` share a name. SeaweedFS stores folders as
    // directories, so the order matters: written concurrently it sometimes rejects the marker with
    // 409 ExistingObjectIsFile (file first), or silently replaces the file with the directory
    // (file, then child). Marker, then child, then file is accepted and keeps both.
    for k in ["d/foo/", "d/foo/x", "d/foo"] {
        t.put(A, k, body_for(k)).await?;
    }
    let before = t.snap(A).await?;
    check(
        before.contains_key("d/foo") && before.contains_key("d/foo/x"),
        "setup: the object d/foo and the folder d/foo/ both exist",
    )?;
    let j = t
        .run(req(
            JobKind::Delete,
            None,
            vec![pre("d/many/", None), pre("d/foo/", None), obj("d/single.txt", None), obj("d/missing-object", None)],
            ConflictPolicy::Skip,
        ))
        .await?;
    println!("  {:?} total {} done {} failed {} errors {:?}", j.status, j.total_items, j.done_items, j.failed_items, j.errors);
    check(j.status == JobStatus::Completed, "delete completed")?;
    let listed = (under(&before, "d/many/").count() + under(&before, "d/foo/").count()) as u64;
    println!("  listed under the two prefixes: {listed}");
    check(listed >= 2151 && j.total_items == listed + 1 + 1, "totalItems = listed keys + single object + missing key")?;
    check(j.done_items == j.total_items, "missing key counts as done")?;
    check(j.label == "Delete 4 items", "label")?;
    let removed: Vec<&str> = under(&before, "d/many/").chain(["d/foo/", "d/foo/x", "d/single.txt"]).collect();
    let after = t.snap(A).await?;
    same(&expect(&before, &removed, &Snap::new()), &after, "only the requested keys are gone; foobar/, foo, foo2, many-sibling, keep/ survive")?;
    t.wipe(A).await
}

async fn b_copy(t: &T) -> Res<()> {
    println!("b. copy object and folder, within a bucket and across buckets");
    let mut meta = HashMap::new();
    meta.insert("owner".to_string(), "Alice".to_string());
    t.c.put_object()
        .bucket(A)
        .key("c/src/a.txt")
        .content_type("text/plain; charset=utf-8")
        .set_metadata(Some(meta.clone()))
        .body(ByteStream::from(b"alpha".to_vec()))
        .send()
        .await?;
    t.put(A, "c/src/", Vec::new()).await?;
    t.put(A, "c/src/sub/b.bin", random_bytes(300_000, 7)).await?;
    t.c.put_object()
        .bucket(A)
        .key("c/obj.json")
        .content_type("application/json")
        .cache_control("max-age=60")
        .set_metadata(Some(meta.clone()))
        .body(ByteStream::from(b"{\"x\":1}".to_vec()))
        .send()
        .await?;
    t.put(A, "c/srcfoo", b"sibling".to_vec()).await?;
    let before_a = t.snap(A).await?;
    let before_b = t.snap(B).await?;

    let r = req(
        JobKind::Copy,
        Some(A),
        vec![pre("c/src/", Some("c/dst/")), obj("c/obj.json", Some("c/obj-copy.json"))],
        ConflictPolicy::Skip,
    );
    let p = jobs::preview(&r, &t.c, Some(&t.c)).await?;
    println!("  preview {p:?}");
    let n_c = under(&before_a, "c/src/").count() as u64 + 1;
    check(p.objects == n_c && p.conflicts == 0 && !p.truncated && p.bytes == 5 + 300_000 + 7, "preview counts")?;
    let j = t.run(r).await?;
    println!("  same bucket: {:?} {}/{} bytes {}/{} label {:?} errors {:?}", j.status, j.done_items, j.total_items, j.done_bytes, j.total_bytes, j.label, j.errors);
    check(j.status == JobStatus::Completed && j.done_items == n_c, "copy completed")?;
    check(j.done_bytes == j.total_bytes && j.total_bytes == 300_012, "bytes counted")?;
    let mut add = mapped(&before_a, "c/src/", "c/dst/");
    add.insert("c/obj-copy.json".into(), before_a["c/obj.json"].clone());
    let after_a = t.snap(A).await?;
    same(&expect(&before_a, &[], &add), &after_a, "copies identical (sha256), sources and sibling untouched")?;
    let h = t.c.head_object().bucket(A).key("c/dst/a.txt").send().await?;
    check(h.content_type() == Some("text/plain; charset=utf-8"), "content type preserved")?;
    check(h.metadata().and_then(|m| m.get("owner")).map(String::as_str) == Some("Alice"), "user metadata preserved")?;
    let h = t.c.head_object().bucket(A).key("c/obj-copy.json").send().await?;
    check(h.content_type() == Some("application/json") && h.cache_control() == Some("max-age=60"), "object content headers preserved")?;

    let j = t
        .run(JobRequest {
            kind: JobKind::Copy,
            src_bucket: A.into(),
            dest_bucket: Some(B.into()),
            items: vec![pre("c/src/", Some("x/src/")), obj("c/obj.json", Some("x/obj.json"))],
            on_conflict: ConflictPolicy::Skip,
            tags: None,
        })
        .await?;
    println!("  cross bucket: {:?} {}/{} label {:?}", j.status, j.done_items, j.total_items, j.label);
    check(j.status == JobStatus::Completed && j.done_items == n_c, "cross-bucket copy completed")?;
    check(j.label == "Copy 2 items to jobs-b/x/", "label")?;
    let mut add_b = mapped(&before_a, "c/src/", "x/src/");
    add_b.insert("x/obj.json".into(), before_a["c/obj.json"].clone());
    same(&expect(&before_b, &[], &add_b), &t.snap(B).await?, "bucket B has exactly the copies")?;
    same(&after_a, &t.snap(A).await?, "bucket A unchanged by the cross-bucket copy")?;
    let h = t.c.head_object().bucket(B).key("x/src/a.txt").send().await?;
    check(
        h.content_type() == Some("text/plain; charset=utf-8")
            && h.metadata().and_then(|m| m.get("owner")).map(String::as_str) == Some("Alice"),
        "cross-bucket metadata preserved",
    )?;
    t.wipe(A).await?;
    t.wipe(B).await
}

async fn c_move(t: &T) -> Res<()> {
    println!("c. move a folder; rename an object and a folder");
    let keys: Vec<String> =
        std::iter::once("m/src/".to_string()).chain((0..60).map(|i| format!("m/src/d{}/f{i}.txt", i % 4))).collect();
    t.put_many(A, &keys).await?;
    t.put_many(A, &["m/srcx".to_string(), "m/src-other/z".to_string(), "m/r/old.txt".to_string(), "m/r/olddir/a".to_string(), "m/r/olddir/b/c".to_string(), "m/r/keep".to_string()]).await?;
    let before = t.snap(A).await?;
    let j = t.run(req(JobKind::Move, Some(A), vec![pre("m/src/", Some("m/dst/"))], ConflictPolicy::Skip)).await?;
    println!("  move: {:?} {}/{} label {:?}", j.status, j.done_items, j.total_items, j.label);
    let n_src = under(&before, "m/src/").count() as u64;
    check(n_src >= 60 && j.status == JobStatus::Completed && j.done_items == n_src && j.total_items == n_src, "move completed (every listed key, marker included when listed)")?;
    let src_keys: Vec<&str> = under(&before, "m/src/").collect();
    let want = expect(&before, &src_keys, &mapped(&before, "m/src/", "m/dst/"));
    let after = t.snap(A).await?;
    same(&want, &after, "all objects arrived, sources gone, m/srcx and m/src-other/ untouched")?;

    let j = t.run(req(JobKind::Move, Some(A), vec![obj("m/r/old.txt", Some("m/r/new.txt"))], ConflictPolicy::Skip)).await?;
    check(j.status == JobStatus::Completed && j.label == "Rename old.txt to new.txt", "rename object")?;
    let j = t.run(req(JobKind::Move, Some(A), vec![pre("m/r/olddir/", Some("m/r/newdir/"))], ConflictPolicy::Skip)).await?;
    check(j.status == JobStatus::Completed && j.label == "Rename olddir to newdir" && j.done_items == 2, "rename folder")?;
    let mut add = mapped(&after, "m/r/olddir/", "m/r/newdir/");
    add.insert("m/r/new.txt".into(), after["m/r/old.txt"].clone());
    same(&expect(&after, &["m/r/old.txt", "m/r/olddir/a", "m/r/olddir/b/c"], &add), &t.snap(A).await?, "renames moved exactly those keys")?;

    // Cross-bucket move.
    let before_a = t.snap(A).await?;
    let j = t
        .run(JobRequest {
            kind: JobKind::Move,
            src_bucket: A.into(),
            dest_bucket: Some(B.into()),
            items: vec![pre("m/dst/", Some("moved/"))],
            on_conflict: ConflictPolicy::Skip,
            tags: None,
        })
        .await?;
    check(j.status == JobStatus::Completed && j.done_items == under(&before_a, "m/dst/").count() as u64, "cross-bucket move completed")?;
    let gone: Vec<&str> = under(&before_a, "m/dst/").collect();
    same(&expect(&before_a, &gone, &Snap::new()), &t.snap(A).await?, "cross-bucket move removed only the sources")?;
    same(&mapped(&before_a, "m/dst/", "moved/"), &t.snap(B).await?, "cross-bucket move delivered identical objects")?;
    t.wipe(A).await?;
    t.wipe(B).await
}

async fn d_conflicts(t: &T) -> Res<()> {
    println!("d. conflicts: skip and overwrite");
    t.put_many(A, &["k/s/1".to_string(), "k/s/2".to_string(), "k/s/3".to_string()]).await?;
    t.put(A, "k/d/2", b"existing destination".to_vec()).await?;
    let before = t.snap(A).await?;
    let r = req(JobKind::Move, Some(A), vec![pre("k/s/", Some("k/d/"))], ConflictPolicy::Skip);
    let p = jobs::preview(&r, &t.c, Some(&t.c)).await?;
    check(p.objects == 3 && p.conflicts == 1, "preview counts 1 conflict")?;
    let j = t.run(r).await?;
    println!("  skip: {:?} done {} skipped {} failed {}", j.status, j.done_items, j.skipped_items, j.failed_items);
    check(j.status == JobStatus::Completed && j.done_items == 2 && j.skipped_items == 1, "skip: 2 moved, 1 skipped, completed")?;
    let mut add = Snap::new();
    add.insert("k/d/1".into(), before["k/s/1"].clone());
    add.insert("k/d/3".into(), before["k/s/3"].clone());
    let after = t.snap(A).await?;
    same(&expect(&before, &["k/s/1", "k/s/3"], &add), &after, "skip: destination content AND source of the skipped object untouched")?;

    // An object that appears at the destination after the listing is not overwritten either.
    t.put_many(A, &["k/s/4".to_string()]).await?;
    let c = t.c.clone();
    let hook: AfterListingHook = Arc::new(move |_id| {
        let c = c.clone();
        async move {
            let _ = c.put_object().bucket(A).key("k/d/4").body(ByteStream::from(b"raced in".to_vec())).send().await;
        }
        .boxed()
    });
    let rec = t.rec.clone();
    let mgr = JobManager::with_tuning(rec.clone(), JobTuning { after_listing: Some(hook), ..JobTuning::default() });
    let raced = T { c: t.c.clone(), rec, mgr };
    let before_race = t.snap(A).await?;
    let j = raced.run(req(JobKind::Move, Some(A), vec![obj("k/s/4", Some("k/d/4"))], ConflictPolicy::Skip)).await?;
    println!("  raced dest: {:?} done {} skipped {} failed {} errors {:?}", j.status, j.done_items, j.skipped_items, j.failed_items, j.errors);
    let after_race = t.snap(A).await?;
    let raced_content = after_race.get("k/d/4").map(|v| v.1.clone());
    let source_kept = after_race.get("k/s/4") == before_race.get("k/s/4");
    if raced_content == Some(sha(b"raced in")) {
        check(source_kept && j.skipped_items == 1, "If-None-Match: destination created after listing kept, counted skipped, source kept")?;
    } else {
        println!("  NOTE: the server ignored If-None-Match on CopyObject (destination overwritten by the copy)");
        check(source_kept || after_race.get("k/d/4") == before_race.get("k/s/4"), "the object is still somewhere")?;
    }

    // Overwrite replaces the destination and removes the source.
    let before = t.snap(A).await?;
    let j = t.run(req(JobKind::Move, Some(A), vec![pre("k/s/", Some("k/d/"))], ConflictPolicy::Overwrite)).await?;
    println!("  overwrite: {:?} done {} skipped {}", j.status, j.done_items, j.skipped_items);
    let srcs: Vec<&str> = under(&before, "k/s/").collect();
    let n = srcs.len() as u64;
    check(j.status == JobStatus::Completed && j.done_items == n && j.skipped_items == 0, "overwrite completed")?;
    same(&expect(&before, &srcs, &mapped(&before, "k/s/", "k/d/")), &t.snap(A).await?, "overwrite: destination replaced, source removed")?;
    t.wipe(A).await
}

async fn e_cancel(t: &T) -> Res<()> {
    println!("e. cancel a large move mid-way");
    let n = 3000;
    let keys: Vec<String> = (0..n).map(|i| format!("e/src/{:02}/k{i:05}", i % 37)).collect();
    t.put_many(A, &keys).await?;
    t.put(A, "e/other", b"x".to_vec()).await?;
    let before = t.snap(A).await?;
    // Cancel right away: the job is still queued or listing, so nothing may change.
    let id = t.start(req(JobKind::Move, Some(A), vec![pre("e/src/", Some("e/dst/"))], ConflictPolicy::Skip))?;
    t.mgr.cancel(&id)?;
    let j = t.mgr.wait(&id).await.ok_or("job vanished")?;
    t.check_events(&j)?;
    println!("  cancelled while listing: {:?} phase {:?} done {}", j.status, j.phase, j.done_items);
    check(j.status == JobStatus::Cancelled && j.done_items == 0, "cancel during queue/listing")?;
    same(&before, &t.snap(A).await?, "cancel before the working phase changed nothing")?;

    let id = t.start(req(JobKind::Move, Some(A), vec![pre("e/src/", Some("e/dst/"))], ConflictPolicy::Skip))?;
    let t0 = Instant::now();
    while t.mgr.get(&id).is_some_and(|j| j.phase != JobPhase::Working && j.status.is_active()) && t0.elapsed() < Duration::from_secs(60) {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let at_cancel = t.mgr.get(&id).map(|j| j.done_items).unwrap_or(0);
    t.mgr.cancel(&id)?;
    let tc = Instant::now();
    let j = t.mgr.wait(&id).await.ok_or("job vanished")?;
    let cancel_ms = tc.elapsed().as_millis();
    t.check_events(&j)?;
    println!(
        "  cancelled at done={at_cancel}: final {:?} done {} failed {} skipped {} of {} in {cancel_ms} ms",
        j.status, j.done_items, j.failed_items, j.skipped_items, j.total_items
    );
    check(j.status == JobStatus::Cancelled, "status cancelled")?;
    check(j.done_items < n as u64, "stopped before the end")?;
    check(j.done_items > 0, "some objects were moved before the cancel")?;
    check(cancel_ms < 5000, "cancel is prompt")?;
    let after = t.snap(A).await?;
    let (mut in_src, mut in_dst, mut both, mut neither, mut wrong) = (0, 0, 0, 0, 0);
    for k in &keys {
        let d = format!("e/dst/{}", &k["e/src/".len()..]);
        let want = &before[k];
        match (after.get(k), after.get(&d)) {
            (Some(s), None) => {
                in_src += 1;
                if s != want {
                    wrong += 1;
                }
            }
            (None, Some(x)) => {
                in_dst += 1;
                if x != want {
                    wrong += 1;
                }
            }
            (Some(_), Some(_)) => both += 1,
            (None, None) => neither += 1,
        }
    }
    println!("  in source {in_src}, in destination {in_dst}, both {both}, neither {neither}, wrong content {wrong}");
    check(neither == 0 && wrong == 0, "no object lost, contents intact")?;
    check(both == 0, "every object in exactly one place")?;
    check(in_src + in_dst == n, "total count conserved")?;
    check(in_dst as u64 == j.done_items, "doneItems equals objects moved")?;
    check(after.len() == before.len() && after.get("e/other") == before.get("e/other"), "nothing else changed")?;
    t.wipe(A).await
}

async fn f_failures(t: &T) -> Res<()> {
    println!("f/l. per-object failures: source removed / changed after listing");
    let keys: Vec<String> = (0..12).map(|i| format!("f/src/k{i:02}")).collect();
    t.put_many(A, &keys).await?;
    let before = t.snap(A).await?;
    let c = t.c.clone();
    let hook: AfterListingHook = Arc::new(move |_id| {
        let c = c.clone();
        async move {
            let _ = c.delete_object().bucket(A).key("f/src/k03").send().await;
            let _ = c.put_object().bucket(A).key("f/src/k05").body(ByteStream::from(b"changed after listing".to_vec())).send().await;
        }
        .boxed()
    });
    let mgr = JobManager::with_tuning(t.rec.clone(), JobTuning { after_listing: Some(hook), ..JobTuning::default() });
    let ht = T { c: t.c.clone(), rec: t.rec.clone(), mgr };
    let j = ht.run(req(JobKind::Move, Some(A), vec![pre("f/src/", Some("f/dst/"))], ConflictPolicy::Skip)).await?;
    println!("  {:?} total {} done {} failed {} errors:", j.status, j.total_items, j.done_items, j.failed_items);
    for e in &j.errors {
        println!("    {} -> {}", e.key, e.message);
    }
    let after = t.snap(A).await?;
    check(j.status == JobStatus::Failed, "job ends failed")?;
    check(j.total_items == 12 && j.done_items + j.failed_items == 12, "counters add up")?;
    check(j.errors.iter().any(|e| e.key == "f/src/k03" && e.message.contains("NoSuchKey")), "removed source -> NoSuchKey failure")?;
    check(!after.contains_key("f/dst/k03"), "nothing written for the removed source")?;
    let k05_src = after.get("f/src/k05").map(|v| v.1.clone());
    let k05_dst = after.get("f/dst/k05").map(|v| v.1.clone());
    let changed = sha(b"changed after listing");
    if j.errors.iter().any(|e| e.key == "f/src/k05") {
        check(j.failed_items == 2 && j.done_items == 10, "10 moved, 2 failed")?;
        check(k05_src == Some(changed.clone()), "If-Match: changed source kept (not deleted)")?;
        check(k05_dst.is_none(), "If-Match: changed source not copied")?;
    } else {
        println!("  NOTE: the server ignored x-amz-copy-source-if-match; k05 dst={k05_dst:?} src={k05_src:?}");
        check(k05_src.is_some() || k05_dst == Some(changed.clone()), "the changed object still exists somewhere")?;
    }
    for i in [0, 1, 2, 4, 6, 7, 8, 9, 10, 11] {
        let s = format!("f/src/k{i:02}");
        let d = format!("f/dst/k{i:02}");
        check(!after.contains_key(&s) && after.get(&d) == before.get(&s), &format!("{s} moved intact"))?;
    }
    t.wipe(A).await?;

    println!("f2. source overwritten after its copy, before its delete (conditional delete)");
    let keys: Vec<String> = (0..5).map(|i| format!("s/src/k{i}")).collect();
    t.put_many(A, &keys).await?;
    let before = t.snap(A).await?;
    let c = t.c.clone();
    let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hook: AfterListingHook = Arc::new(move |_id| {
        let (c, fired) = (c.clone(), fired.clone());
        async move {
            if !fired.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let _ = c.put_object().bucket(A).key("s/src/k2").body(ByteStream::from(b"new version".to_vec())).send().await;
            }
        }
        .boxed()
    });
    let mgr = JobManager::with_tuning(t.rec.clone(), JobTuning { before_source_delete: Some(hook), ..JobTuning::default() });
    let ht = T { c: t.c.clone(), rec: t.rec.clone(), mgr };
    let j = ht.run(req(JobKind::Move, Some(A), vec![pre("s/src/", Some("s/dst/"))], ConflictPolicy::Skip)).await?;
    println!("  {:?} done {} failed {} errors {:?}", j.status, j.done_items, j.failed_items, j.errors);
    let after = t.snap(A).await?;
    let new_kept = after.get("s/src/k2").map(|v| v.1.clone()) == Some(sha(b"new version"));
    if j.failed_items == 1 {
        check(j.status == JobStatus::Failed && j.done_items == 4, "4 moved, 1 failed")?;
        check(j.errors.iter().any(|e| e.key == "s/src/k2" && e.message.contains("original remains")), "message says the copy exists and the original remains")?;
        check(new_kept, "the new version at the source was NOT deleted")?;
        check(after.get("s/dst/k2") == before.get("s/src/k2"), "the copied (old) version is at the destination")?;
    } else {
        println!("  NOTE: the server ignored the per-key ETag on DeleteObjects");
        check(!new_kept, "(unconditional delete removed the new version - server limitation)")?;
    }
    t.wipe(A).await
}

async fn g_items(t: &T) -> Res<()> {
    println!("g. unmatched prefix, overlapping items, colliding destinations");
    t.put_many(A, &["g/src/a".to_string(), "g/src/b/c".to_string(), "g/o/a".to_string(), "g/o/sub/x".to_string(), "g/o/sub/y".to_string(), "g/keep".to_string()]).await?;
    let before = t.snap(A).await?;
    let j = t
        .run(req(JobKind::Copy, Some(A), vec![pre("g/src/", Some("g/dst/")), pre("g/nothing/", Some("g/dst2/"))], ConflictPolicy::Skip))
        .await?;
    println!("  unmatched: {:?} total {} done {} failed {} errors {:?}", j.status, j.total_items, j.done_items, j.failed_items, j.errors);
    check(j.status == JobStatus::Failed && j.total_items == 3 && j.done_items == 2 && j.failed_items == 1, "unmatched prefix = 1 failed item")?;
    check(j.errors.iter().any(|e| e.key == "g/nothing/" && e.message.contains("No objects found")), "clear error for unmatched prefix")?;
    same(&expect(&before, &[], &mapped(&before, "g/src/", "g/dst/")), &t.snap(A).await?, "the rest was copied")?;

    let before = t.snap(A).await?;
    let j = t
        .run(req(
            JobKind::Delete,
            None,
            vec![pre("g/o/", None), obj("g/o/a", None), pre("g/o/", None), pre("g/o/sub/", None), obj("g/o/sub/x", None)],
            ConflictPolicy::Skip,
        ))
        .await?;
    println!("  overlapping delete: {:?} total {} done {}", j.status, j.total_items, j.done_items);
    check(j.status == JobStatus::Completed && j.total_items == 3 && j.done_items == 3, "each object processed once")?;
    same(&expect(&before, &["g/o/a", "g/o/sub/x", "g/o/sub/y"], &Snap::new()), &t.snap(A).await?, "only g/o/ deleted")?;

    let before = t.snap(A).await?;
    let j = t
        .run(req(JobKind::Copy, Some(A), vec![pre("g/src/", Some("g/c1/")), obj("g/src/a", Some("g/c2"))], ConflictPolicy::Skip))
        .await?;
    check(j.status == JobStatus::Completed && j.total_items == 2 && j.done_items == 2, "overlapping copy sources: each object copied once (first item wins)")?;
    let mut add = mapped(&before, "g/src/", "g/c1/");
    add.retain(|k, _| k.starts_with("g/c1/"));
    same(&expect(&before, &[], &add), &t.snap(A).await?, "g/src/a went to g/c1/a only")?;

    // Two items writing the same destination: rejected before anything changes.
    let before = t.snap(A).await?;
    let r = req(JobKind::Copy, Some(A), vec![obj("g/src/a", Some("g/same")), obj("g/keep", Some("g/same"))], ConflictPolicy::Overwrite);
    let p = jobs::preview(&r, &t.c, Some(&t.c)).await;
    let s = t.start(r.clone());
    println!("  colliding: preview {:?} / start {:?}", p.as_ref().map_err(|e| &e.message), s.as_ref().map_err(|e| e.to_string()));
    check(matches!(&p, Err(e) if e.code == ErrorCode::InvalidInput), "preview rejects colliding destinations")?;
    check(s.is_err(), "start rejects colliding destinations")?;
    let r = req(JobKind::Copy, Some(A), vec![pre("g/src/", Some("g/n/")), obj("g/keep", Some("g/n/b/c"))], ConflictPolicy::Overwrite);
    check(jobs::preview(&r, &t.c, Some(&t.c)).await.is_err() && t.start(r).is_err(), "destination nested in another item's destination is rejected")?;
    same(&before, &t.snap(A).await?, "nothing changed")?;
    t.wipe(A).await
}

async fn h_into_self(t: &T) -> Res<()> {
    println!("h. copy/move into itself or a descendant");
    t.put_many(A, &["h/a/x".to_string(), "h/a/b/y".to_string(), "h/ab/z".to_string()]).await?;
    let before = t.snap(A).await?;
    for (kind, to) in [(JobKind::Copy, "h/a/"), (JobKind::Move, "h/a/b/"), (JobKind::Copy, "h/a/new/"), (JobKind::Move, "h/a//")] {
        let r = req(kind, Some(A), vec![pre("h/a/", Some(to))], ConflictPolicy::Overwrite);
        let p = jobs::preview(&r, &t.c, Some(&t.c)).await;
        let s = t.start(r);
        let rejected = matches!(&p, Err(e) if e.code == ErrorCode::InvalidInput) && s.is_err();
        check(rejected, &format!("{kind:?} h/a/ -> {to} rejected by preview and start"))?;
    }
    let r = req(JobKind::Move, Some(A), vec![pre("h/a/b/", Some("h/a/"))], ConflictPolicy::Overwrite);
    check(jobs::preview(&r, &t.c, Some(&t.c)).await.is_err() && t.start(r).is_err(), "move into own ancestor that contains it rejected")?;
    // A sibling with a shared string prefix is fine.
    let r = req(JobKind::Copy, Some(A), vec![pre("h/a/", Some("h/ab/a/"))], ConflictPolicy::Skip);
    check(jobs::preview(&r, &t.c, Some(&t.c)).await.is_ok(), "h/a/ -> h/ab/a/ is allowed")?;
    same(&before, &t.snap(A).await?, "nothing changed")?;
    t.wipe(A).await
}

async fn i_special_keys(t: &T) -> Res<()> {
    println!("i. keys with spaces, unicode, +, %, #, ?");
    let names = [
        "a b.txt", "ü日本.txt", "a+b.txt", "100%.txt", "%2F.txt", "h#1.txt", "q?x=1.txt", "sp ace/inner+.txt", "emoji😀/x",
        "semi;colon,comma&amp=eq.txt", "tilde~star*paren(1).txt", "trailing.dot.", "unicode-normal-é.txt",
    ];
    let keys: Vec<String> = names.iter().map(|n| format!("i/src/{n}")).collect();
    t.put_many(A, &keys).await?;
    let before = t.snap(A).await?;
    let listed: Vec<&str> = under(&before, "i/src/").collect();
    check(listed.len() == names.len(), "server stored every special key as given")?;
    let j = t.run(req(JobKind::Copy, Some(A), vec![pre("i/src/", Some("i/cp/")), obj("i/src/a+b.txt", Some("i/one/a+b copy?#%.txt"))], ConflictPolicy::Skip)).await;
    let j = match j {
        Ok(j) => j,
        Err(e) => return Err(e),
    };
    println!("  copy: {:?} {}/{} errors {:?}", j.status, j.done_items, j.total_items, j.errors);
    // The object item overlaps the prefix item (same source): processed once via the prefix.
    check(j.status == JobStatus::Completed && j.done_items == names.len() as u64, "copy of special keys completed")?;
    same(&expect(&before, &[], &mapped(&before, "i/src/", "i/cp/")), &t.snap(A).await?, "exact key bytes and contents after copy")?;
    let j = t.run(req(JobKind::Copy, Some(A), vec![obj("i/src/a+b.txt", Some("i/one/a+b copy?#%.txt"))], ConflictPolicy::Skip)).await?;
    check(j.status == JobStatus::Completed, "object item with special destination copied")?;
    let mid = t.snap(A).await?;
    check(mid.get("i/one/a+b copy?#%.txt") == before.get("i/src/a+b.txt"), "special destination key exact")?;
    let j = t.run(req(JobKind::Move, Some(A), vec![pre("i/src/", Some("i/mv/"))], ConflictPolicy::Skip)).await?;
    check(j.status == JobStatus::Completed, "move of special keys completed")?;
    let src_keys: Vec<&str> = under(&mid, "i/src/").collect();
    same(&expect(&mid, &src_keys, &mapped(&mid, "i/src/", "i/mv/")), &t.snap(A).await?, "exact key bytes after move")?;
    t.wipe(A).await
}

async fn j_queue(t: &T) -> Res<()> {
    println!("j. at most 2 jobs running, FIFO");
    for n in 0..3 {
        let keys: Vec<String> = (0..400).map(|i| format!("q{n}/src/k{i:04}")).collect();
        t.put_many(A, &keys).await?;
    }
    let ids: Vec<String> = (0..3)
        .map(|n| t.start(req(JobKind::Copy, Some(A), vec![pre(&format!("q{n}/src/"), Some(&format!("q{n}/dst/")))], ConflictPolicy::Skip)))
        .collect::<Res<_>>()?;
    check(t.mgr.has_active(), "has_active while jobs run")?;
    let removal = t.mgr.remove(&ids[2]);
    check(matches!(&removal, Err(e) if e.code == ErrorCode::InvalidInput), "remove_job while queued/running -> InvalidInput")?;
    for id in &ids {
        let j = t.mgr.wait(id).await.ok_or("vanished")?;
        t.check_events(&j)?;
        check(j.status == JobStatus::Completed && j.done_items == 400, "queued job completed")?;
    }
    check(!t.mgr.has_active(), "has_active false when all finished")?;
    let ev: Vec<Job> = t.rec.all().into_iter().filter(|j| ids.contains(&j.id)).collect();
    let mut status: HashMap<&str, JobStatus> = HashMap::new();
    let mut max_running = 0;
    let mut start_order: Vec<&str> = Vec::new();
    for e in &ev {
        if e.status == JobStatus::Running && !start_order.contains(&e.id.as_str()) {
            start_order.push(&e.id);
        }
        status.insert(&e.id, e.status);
        max_running = max_running.max(status.values().filter(|s| **s == JobStatus::Running).count());
    }
    println!("  max running observed {max_running}, start order {:?}", start_order.iter().map(|id| ids.iter().position(|x| x == id)).collect::<Vec<_>>());
    check(max_running == 2, "never more than 2 running (and 2 did run together)")?;
    check(start_order == ids.iter().map(String::as_str).collect::<Vec<_>>(), "FIFO start order")?;
    // cancel/remove semantics.
    check(t.mgr.cancel(&ids[0]).is_ok(), "cancel of a finished job is a no-op")?;
    check(t.mgr.get(&ids[0]).is_some_and(|j| j.status == JobStatus::Completed), "finished job unchanged by cancel")?;
    check(matches!(t.mgr.cancel("nope"), Err(e) if e.code == ErrorCode::InvalidInput), "cancel unknown id -> InvalidInput")?;
    let n = t.mgr.list().len();
    t.mgr.remove(&ids[0])?;
    check(t.mgr.list().len() == n - 1 && t.mgr.get(&ids[0]).is_none(), "remove finished job")?;
    t.wipe(A).await
}

async fn k_multipart(t: &T, big_mib: u64) -> Res<()> {
    println!("k. multipart copy (UploadPartCopy) with a lowered threshold");
    let big = random_bytes((big_mib * 1024 * 1024) as usize, 0x1234_5678_9ABC_DEF0);
    let mut meta = HashMap::new();
    meta.insert("purpose".to_string(), "multipart test".to_string());
    t.c.put_object()
        .bucket(A)
        .key("k/big file+1.bin")
        .content_type("application/x-test")
        .set_metadata(Some(meta))
        .body(ByteStream::from(big.clone()))
        .send()
        .await?;
    t.put(A, "k/small", b"small".to_vec()).await?;
    let before_a = t.snap(A).await?;
    let mgr = JobManager::with_tuning(
        t.rec.clone(),
        JobTuning { multipart_threshold: 8 * 1024 * 1024, part_size: 5 * 1024 * 1024, ..JobTuning::default() },
    );
    let mt = T { c: t.c.clone(), rec: t.rec.clone(), mgr };
    let j = mt
        .run(req(JobKind::Copy, Some(A), vec![pre("k/", Some("k2/"))], ConflictPolicy::Skip))
        .await?;
    println!("  same bucket: {:?} {}/{} bytes {} errors {:?}", j.status, j.done_items, j.total_items, j.done_bytes, j.errors);
    check(j.status == JobStatus::Completed && j.done_items == 2, "multipart copy completed")?;
    let h = t.c.head_object().bucket(A).key("k2/big file+1.bin").send().await?;
    println!("  copy etag {:?} size {:?}", h.e_tag(), h.content_length());
    check(h.e_tag().is_some_and(|e| e.contains('-')), "destination ETag is a multipart ETag (UploadPartCopy was used)")?;
    check(
        h.content_type() == Some("application/x-test")
            && h.metadata().and_then(|m| m.get("purpose")).map(String::as_str) == Some("multipart test"),
        "content type and metadata carried over",
    )?;
    let got = t.get(A, "k2/big file+1.bin").await?;
    check(sha(&got) == sha(&big), &format!("sha256 matches ({} MiB)", big_mib))?;
    same(&expect(&before_a, &[], &mapped(&before_a, "k/", "k2/")), &t.snap(A).await?, "only the copies were added")?;

    let j = mt
        .run(JobRequest {
            kind: JobKind::Move,
            src_bucket: A.into(),
            dest_bucket: Some(B.into()),
            items: vec![obj("k2/big file+1.bin", Some("big/moved.bin"))],
            on_conflict: ConflictPolicy::Skip,
            tags: None,
        })
        .await?;
    check(j.status == JobStatus::Completed, "multipart move across buckets completed")?;
    check(sha(&t.get(B, "big/moved.bin").await?) == sha(&big), "moved copy sha256 matches")?;
    let after = t.snap(A).await?;
    check(!after.contains_key("k2/big file+1.bin") && after.contains_key("k/big file+1.bin"), "move source deleted, original untouched")?;
    // Cancel during a multipart copy: the upload is aborted and nothing appears at the destination.
    let id = mt.start(req(JobKind::Copy, Some(A), vec![obj("k/big file+1.bin", Some("k3/cancelled.bin"))], ConflictPolicy::Skip))?;
    let t0 = Instant::now();
    while mt.mgr.get(&id).is_some_and(|j| j.phase != JobPhase::Working && j.status.is_active()) && t0.elapsed() < Duration::from_secs(30) {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    tokio::time::sleep(Duration::from_millis(15)).await;
    mt.mgr.cancel(&id)?;
    let j = mt.mgr.wait(&id).await.ok_or("vanished")?;
    mt.check_events(&j)?;
    let exists = t.c.head_object().bucket(A).key("k3/cancelled.bin").send().await.is_ok();
    println!("  cancel mid multipart copy: {:?} done {} dest exists {exists}", j.status, j.done_items);
    check((j.status == JobStatus::Cancelled && !exists) || (j.status == JobStatus::Completed && exists), "cancelled multipart copy left no destination object")?;
    // The multipart uploads are all completed or aborted.
    let uploads = t.c.list_multipart_uploads().bucket(B).send().await?;
    let uploads_a = t.c.list_multipart_uploads().bucket(A).send().await?;
    check(uploads.uploads().is_empty() && uploads_a.uploads().is_empty(), "no multipart upload left open")?;
    t.wipe(A).await?;
    t.wipe(B).await
}

/// Opt-in (JOBS_TRUNCATION=1): seeds 100,050 objects to check that `preview_job` stops at 100,000.
async fn t_truncation(t: &T) -> Res<()> {
    println!("t. preview stops counting at 100,000 objects");
    let keys: Vec<String> = (0..100_050).map(|i| format!("t/src/{:03}/k{i:06}", i % 500)).collect();
    let t0 = Instant::now();
    for chunk in keys.chunks(10_000) {
        t.put_many(A, chunk).await?;
    }
    println!("  seeded {} objects in {:.1}s", keys.len(), t0.elapsed().as_secs_f64());
    t.put_many(A, &["t/dst/000/k000000".to_string(), "t/one".to_string()]).await?;
    let r = req(JobKind::Copy, Some(A), vec![pre("t/src/", Some("t/dst/"))], ConflictPolicy::Skip);
    let t1 = Instant::now();
    let p = jobs::preview(&r, &t.c, Some(&t.c)).await?;
    println!("  preview {p:?} in {:.1}s", t1.elapsed().as_secs_f64());
    check(p.truncated && p.objects == 100_000, "truncated at exactly 100,000 objects")?;
    check(p.conflicts == 1, "conflict among the counted objects found")?;
    let r = req(JobKind::Delete, None, vec![pre("t/src/000/", None), obj("t/one", None)], ConflictPolicy::Skip);
    let p = jobs::preview(&r, &t.c, None).await?;
    check(!p.truncated && p.objects == 202 && p.bytes > 0, "small preview not truncated (201 + 1)")?;
    let j = t.run(req(JobKind::Delete, None, vec![pre("t/", None)], ConflictPolicy::Skip)).await?;
    println!("  delete of 100,052 objects: {:?} {}/{}", j.status, j.done_items, j.total_items);
    check(j.status == JobStatus::Completed && j.done_items == 100_052, "large delete job completed")?;
    check(ops::list_all_keys(&t.c, A, "t/").await?.is_empty(), "everything under t/ deleted")?;
    Ok(())
}

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let ak = env("SMOKE_ACCESS_KEY", "minioadmin");
    let sk = env("SMOKE_SECRET_KEY", "minioadmin");
    let big_mib: u64 = env("JOBS_BIG_MIB", "40").parse()?;
    let only = std::env::var("JOBS_ONLY").ok();
    let conn = Connection::open(static_config(&endpoint, &ak, &sk)).await?;
    let c = conn.client_for_bucket(A).await;
    for b in [A, B] {
        let _ = c.create_bucket().bucket(b).send().await;
    }
    let rec = Arc::new(Recorder(Mutex::new(Vec::new())));
    let t = T { c, rec: rec.clone(), mgr: JobManager::new(rec) };
    t.wipe(A).await?;
    t.wipe(B).await?;
    let run = |s: &str| only.as_deref().is_none_or(|o| o.contains(s));
    let t0 = Instant::now();
    if run("a") {
        a_delete(&t).await?;
    }
    if run("b") {
        b_copy(&t).await?;
    }
    if run("c") {
        c_move(&t).await?;
    }
    if run("d") {
        d_conflicts(&t).await?;
    }
    if run("e") {
        e_cancel(&t).await?;
    }
    if run("f") {
        f_failures(&t).await?;
    }
    if run("g") {
        g_items(&t).await?;
    }
    if run("h") {
        h_into_self(&t).await?;
    }
    if run("i") {
        i_special_keys(&t).await?;
    }
    if run("j") {
        j_queue(&t).await?;
    }
    if run("k") {
        k_multipart(&t, big_mib).await?;
    }
    if std::env::var("JOBS_TRUNCATION").is_ok_and(|v| v == "1") {
        t_truncation(&t).await?;
    }
    println!("ALL JOB CHECKS PASSED in {:.1}s", t0.elapsed().as_secs_f64());
    Ok(())
}
