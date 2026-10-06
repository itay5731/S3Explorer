//! Background object operations ("jobs"): delete, copy, move (and rename = move), and bulk tag
//! edits (`tag`).
//!
//! A job runs in two strict phases: **listing** (expand prefixes, look up single objects, detect
//! destination conflicts and collisions) and only then **working** (the first change to any
//! object). At most [`MAX_RUNNING_JOBS`] run at once; the rest queue in FIFO order. Progress is
//! reported through a [`JobSink`] (`job:progress` in the app): at most every 100 ms while
//! running and always on status or phase changes; the first event is `queued`, the last
//! carries `finishedAt`, and the run slot is released only after that last event.

mod engine;
pub mod plan;
pub mod validate;

use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use aws_sdk_s3::Client;
use dashmap::DashMap;
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::models::{
    now_iso, ConflictPolicy, Job, JobError, JobKind, JobPhase, JobPreview, JobRequest, JobStatus, JOB_MAX_ERRORS,
    JOB_PREVIEW_CAP,
};
use crate::transfers::gate::RunGate;
use engine::Ctx;
pub use validate::validate;

/// Jobs running at once (others queue).
pub const MAX_RUNNING_JOBS: usize = 2;
const TICK: Duration = Duration::from_millis(100);

/// Receives `Job` snapshots (the Tauri app emits them as `job:progress`).
pub trait JobSink: Send + Sync + 'static {
    fn emit(&self, job: &Job);
}

/// A sink that drops every event.
pub struct NoopJobSink;
impl JobSink for NoopJobSink {
    fn emit(&self, _job: &Job) {}
}

impl<F: Fn(&Job) + Send + Sync + 'static> JobSink for F {
    fn emit(&self, job: &Job) {
        self(job)
    }
}

/// Test hook, called with the job id (see [`JobTuning`]).
pub type AfterListingHook = Arc<dyn Fn(String) -> BoxFuture<'static, ()> + Send + Sync>;

/// Internal knobs, for tests only (never exposed to the UI).
#[doc(hidden)]
#[derive(Clone)]
pub struct JobTuning {
    /// Objects larger than this use multipart copy (default 5 GiB, the `CopyObject` limit).
    pub multipart_threshold: u64,
    /// Starting multipart-copy part size (default 256 MiB; at least 5 MiB is used).
    pub part_size: u64,
    /// Awaited after the listing phase, before the first change.
    pub after_listing: Option<AfterListingHook>,
    /// Awaited before each batch of move-source deletes (after those copies were confirmed).
    pub before_source_delete: Option<AfterListingHook>,
}

impl Default for JobTuning {
    fn default() -> Self {
        Self {
            multipart_threshold: plan::COPY_OBJECT_MAX,
            part_size: plan::COPY_PART_SIZE,
            after_listing: None,
            before_source_delete: None,
        }
    }
}

pub struct JobEntry {
    seq: u64,
    record: Mutex<Job>,
    cancel: CancellationToken,
    finished: CancellationToken,
}

impl JobEntry {
    fn lock(&self) -> MutexGuard<'_, Job> {
        self.record.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn snapshot(&self) -> Job {
        self.lock().clone()
    }
    fn status(&self) -> JobStatus {
        self.lock().status
    }
    /// One object processed successfully.
    pub(crate) fn done(&self, bytes: u64) {
        let mut j = self.lock();
        j.done_items += 1;
        j.done_bytes += bytes;
    }
    pub(crate) fn skipped(&self) {
        self.lock().skipped_items += 1;
    }
    pub(crate) fn fail(&self, key: &str, message: String) {
        let mut j = self.lock();
        j.failed_items += 1;
        if j.errors.len() < JOB_MAX_ERRORS {
            j.errors.push(JobError { key: key.to_string(), message });
        }
    }
}

pub struct JobManager {
    entries: DashMap<String, Arc<JobEntry>>,
    gate: Arc<RunGate>,
    sink: Arc<dyn JobSink>,
    seq: AtomicU64,
    tuning: JobTuning,
}

/// Validates `req` and counts what it would touch, without changing anything.
pub async fn preview(req: &JobRequest, src: &Client, dest: Option<&Client>) -> AppResult<JobPreview> {
    validate(req)?;
    if is_transfer(req.kind) && dest.is_none() {
        return Err(AppError::invalid("destBucket is required"));
    }
    let cancel = CancellationToken::new();
    let tuning = JobTuning::default();
    let ctx = Ctx { req, src, dest, cancel: &cancel, tuning: &tuning };
    let (exp, mut truncated) = engine::expand(&ctx, true, Some(JOB_PREVIEW_CAP), &|_| {}).await?;
    let same_bucket = req.dest_bucket.as_deref() == Some(req.src_bucket.as_str());
    plan::check_collisions(&exp.work, same_bucket).map_err(AppError::invalid)?;
    let conflicts = if !is_transfer(req.kind) {
        0
    } else {
        let (existing, t) = engine::existing_dests(&ctx, &exp, Some(JOB_PREVIEW_CAP)).await?;
        truncated |= t;
        existing.len() as u64
    };
    Ok(JobPreview { objects: exp.work.len() as u64, bytes: exp.bytes(), conflicts, truncated })
}

/// Copy and move write to a destination; delete and tag change objects in place.
fn is_transfer(kind: JobKind) -> bool {
    matches!(kind, JobKind::Copy | JobKind::Move)
}

impl JobManager {
    pub fn new(sink: Arc<dyn JobSink>) -> Arc<Self> {
        Self::with_tuning(sink, JobTuning::default())
    }

    #[doc(hidden)]
    pub fn with_tuning(sink: Arc<dyn JobSink>, tuning: JobTuning) -> Arc<Self> {
        Arc::new(Self {
            entries: DashMap::new(),
            gate: RunGate::new(MAX_RUNNING_JOBS),
            sink,
            seq: AtomicU64::new(0),
            tuning,
        })
    }

    /// Validates and queues a job; returns its id. `src` / `dest` are clients for the source
    /// and destination buckets (each in its own region). Must be called within a Tokio runtime.
    pub fn start(self: &Arc<Self>, req: JobRequest, src: Client, dest: Option<Client>) -> AppResult<String> {
        validate(&req)?;
        if is_transfer(req.kind) && dest.is_none() {
            return Err(AppError::invalid("destBucket is required"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = Job {
            id: id.clone(),
            kind: req.kind,
            src_bucket: req.src_bucket.clone(),
            dest_bucket: if is_transfer(req.kind) { req.dest_bucket.clone() } else { None },
            label: plan::label(&req),
            phase: JobPhase::Listing,
            total_items: 0,
            done_items: 0,
            skipped_items: 0,
            failed_items: 0,
            total_bytes: 0,
            done_bytes: 0,
            status: JobStatus::Queued,
            error: None,
            errors: Vec::new(),
            started_at: now_iso(),
            finished_at: None,
        };
        let entry = Arc::new(JobEntry {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            record: Mutex::new(record),
            cancel: CancellationToken::new(),
            finished: CancellationToken::new(),
        });
        self.entries.insert(id.clone(), entry.clone());
        self.sink.emit(&entry.snapshot());
        let me = self.clone();
        tokio::spawn(async move { me.run(entry, req, src, dest).await });
        Ok(id)
    }

    async fn run(self: Arc<Self>, entry: Arc<JobEntry>, req: JobRequest, src: Client, dest: Option<Client>) {
        let permit = tokio::select! {
            biased;
            _ = entry.cancel.cancelled() => None,
            p = self.gate.acquire() => Some(p),
        };
        let result = match &permit {
            None => Err(AppError::cancelled()),
            Some(_) => {
                entry.lock().status = JobStatus::Running;
                self.sink.emit(&entry.snapshot());
                let stop = CancellationToken::new();
                let ticker = tokio::spawn(ticker(self.sink.clone(), entry.clone(), stop.clone()));
                // A panic must not leave the job "running" forever (has_active() would block the
                // updater): it becomes a job-level failure and `finish` still runs. A multipart
                // copy in flight is aborted by its drop guard. Release builds use
                // `panic = "abort"`, so there a panic still ends the whole process.
                let r = AssertUnwindSafe(self.execute(&entry, &req, &src, dest.as_ref()))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|p| Err(AppError::from_panic(&*p)));
                stop.cancel();
                let _ = ticker.await;
                r
            }
        };
        {
            let mut j = entry.lock();
            finish(&mut j, result, entry.cancel.is_cancelled());
        }
        self.sink.emit(&entry.snapshot());
        // Release the slot only after the final event (see transfers).
        drop(permit);
        entry.finished.cancel();
    }

    async fn execute(&self, entry: &JobEntry, req: &JobRequest, src: &Client, dest: Option<&Client>) -> AppResult<()> {
        let ctx = Ctx { req, src, dest, cancel: &entry.cancel, tuning: &self.tuning };
        let transfer = is_transfer(req.kind);

        // ---- listing phase: nothing is changed here ----
        let on_page = |n: u64| entry.lock().total_items += n;
        // Single objects are looked up for every kind but delete (deleting a missing key is a
        // no-op; copying or tagging one is a per-object failure).
        let (mut exp, _) = engine::expand(&ctx, req.kind != JobKind::Delete, None, &on_page).await?;
        engine::require_move_etags(&ctx, &mut exp).await?;
        {
            let mut j = entry.lock();
            j.total_items = (exp.work.len() + exp.missing.len()) as u64;
            // A tag job moves no data: doneBytes / totalBytes stay 0.
            j.total_bytes = if req.kind == JobKind::Tag { 0 } else { exp.bytes() };
        }
        let same_bucket = req.dest_bucket.as_deref() == Some(req.src_bucket.as_str());
        plan::check_collisions(&exp.work, same_bucket).map_err(|m| AppError::new(crate::error::ErrorCode::InvalidInput, m))?;
        let existing = if transfer && req.on_conflict == ConflictPolicy::Skip {
            engine::existing_dests(&ctx, &exp, None).await?.0
        } else {
            HashSet::new()
        };
        for m in &exp.missing {
            entry.fail(&m.key, m.message.clone());
        }
        if entry.cancel.is_cancelled() {
            return Err(AppError::cancelled());
        }
        if let Some(hook) = &self.tuning.after_listing {
            let id = entry.lock().id.clone();
            hook(id).await;
        }

        // ---- working phase ----
        entry.lock().phase = JobPhase::Working;
        self.sink.emit(&entry.snapshot());
        match req.kind {
            JobKind::Copy | JobKind::Move => engine::run_transfer(&ctx, entry, &exp.work, &existing).await,
            JobKind::Delete => engine::run_delete(&ctx, entry, &exp.work).await,
            JobKind::Tag => return engine::run_tag(&ctx, entry, &exp.work).await,
        }
        Ok(())
    }

    /// Cooperative cancel. `InvalidInput` for an unknown id; no-op for a finished job.
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let entry = self.entries.get(id).map(|e| e.clone()).ok_or_else(|| AppError::invalid("Unknown job id"))?;
        entry.cancel.cancel();
        Ok(())
    }

    /// Forgets a finished job. `InvalidInput` while queued/running; unknown id is a no-op.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let Some(entry) = self.entries.get(id).map(|e| e.clone()) else {
            return Ok(());
        };
        if entry.status().is_active() {
            return Err(AppError::invalid("Job is still active; cancel it first"));
        }
        self.entries.remove(id);
        Ok(())
    }

    /// All known jobs, oldest first.
    pub fn list(&self) -> Vec<Job> {
        let mut v: Vec<(u64, Job)> = self.entries.iter().map(|e| (e.seq, e.snapshot())).collect();
        v.sort_by_key(|(s, _)| *s);
        v.into_iter().map(|(_, j)| j).collect()
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.entries.get(id).map(|e| e.snapshot())
    }

    /// True while any job is queued or running (the updater refuses to install then).
    pub fn has_active(&self) -> bool {
        self.entries.iter().any(|e| e.status().is_active())
    }

    /// Jobs holding a run slot right now.
    pub fn running_count(&self) -> usize {
        self.gate.running()
    }

    /// Waits until the job reaches a final state and returns it.
    pub async fn wait(&self, id: &str) -> Option<Job> {
        let entry = self.entries.get(id).map(|e| e.clone())?;
        entry.finished.cancelled().await;
        Some(entry.snapshot())
    }
}

/// Applies the final state: `phase: done`, `finishedAt`, and the status rule — `cancelled` when
/// cancelled (or cancel was requested and not every object was processed), `failed` on a
/// job-level error or when any object failed, otherwise `completed`.
fn finish(j: &mut Job, result: AppResult<()>, cancel_requested: bool) {
    j.phase = JobPhase::Done;
    j.finished_at = Some(now_iso());
    let processed = j.done_items + j.skipped_items + j.failed_items;
    j.status = match result {
        Err(e) if e.is_cancelled() => JobStatus::Cancelled,
        Err(e) => {
            j.error = Some(e.message);
            JobStatus::Failed
        }
        Ok(()) if cancel_requested && processed < j.total_items => JobStatus::Cancelled,
        Ok(()) if j.failed_items > 0 => JobStatus::Failed,
        Ok(()) => JobStatus::Completed,
    };
}

/// Emits progress at most every 100 ms while a job runs, only when something changed.
async fn ticker(sink: Arc<dyn JobSink>, entry: Arc<JobEntry>, stop: CancellationToken) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await; // the first tick is immediate; the "running" event was just sent
    let mut last: Option<(u64, u64, u64, u64, u64, u64, JobPhase)> = None;
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            _ = interval.tick() => {}
        }
        let snap = entry.snapshot();
        let key = (
            snap.total_items,
            snap.done_items,
            snap.skipped_items,
            snap.failed_items,
            snap.total_bytes,
            snap.done_bytes,
            snap.phase,
        );
        if last != Some(key) {
            last = Some(key);
            sink.emit(&snap);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::JobItem;
    use crate::testutil::{h, FakeS3, Reply, Req};

    // ---- end-to-end against a scripted fake S3 (fabricated DeleteObjects / listing answers) ----

    fn delete_result(deleted: &[&str], errors: &[(Option<&str>, &str)]) -> String {
        let mut x = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#);
        for k in deleted {
            x.push_str(&format!("<Deleted><Key>{k}</Key></Deleted>"));
        }
        for (k, code) in errors {
            x.push_str("<Error>");
            if let Some(k) = k {
                x.push_str(&format!("<Key>{k}</Key>"));
            }
            x.push_str(&format!("<Code>{code}</Code><Message>fabricated</Message></Error>"));
        }
        x.push_str("</DeleteResult>");
        x
    }

    fn is_delete(r: &Req) -> bool {
        r.method == "POST" && r.has_query("delete")
    }

    fn obj(from: &str, to: Option<&str>) -> JobItem {
        JobItem { from: from.into(), to: to.map(Into::into), is_prefix: false }
    }

    fn request(kind: JobKind, items: Vec<JobItem>) -> JobRequest {
        JobRequest {
            kind,
            src_bucket: "b".into(),
            dest_bucket: if kind == JobKind::Delete { None } else { Some("b".into()) },
            items,
            on_conflict: ConflictPolicy::Overwrite,
            tags: None,
        }
    }

    async fn run(req: JobRequest, client: &Client) -> (Job, Arc<JobManager>) {
        let m = JobManager::new(Arc::new(NoopJobSink));
        let dest = (req.kind != JobKind::Delete).then(|| client.clone());
        let id = m.start(req, client.clone(), dest).expect("start");
        let j = tokio::time::timeout(Duration::from_secs(60), m.wait(&id)).await.expect("job finished").expect("known");
        (j, m)
    }

    fn tagging_xml(n: usize) -> String {
        let tags: String = (0..n).map(|i| format!("<Tag><Key>t{i}</Key><Value>v</Value></Tag>")).collect();
        format!(r#"<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet>{tags}</TagSet></Tagging>"#)
    }

    fn tag_request(items: Vec<JobItem>, op: crate::models::TagOperation) -> JobRequest {
        JobRequest { dest_bucket: None, tags: Some(op), ..request(JobKind::Tag, items) }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tag_merge_over_the_limit_leaves_the_object_alone() {
        use crate::models::{Tag, TagMode, TagOperation};
        let s3 = FakeS3::start(|r| {
            let key = r.path.trim_start_matches("/b/");
            match (r.method.as_str(), r.has_query("tagging")) {
                ("HEAD", _) if key == "gone" => Reply::status(404),
                ("HEAD", _) => Reply::with_headers(200, vec![h("Content-Length", "7"), h("ETag", "\"e\"")]),
                ("GET", true) if key == "full" => Reply::xml(200, &tagging_xml(10)),
                ("GET", true) if key == "same" => {
                    Reply::xml(200, r#"<Tagging><TagSet><Tag><Key>new</Key><Value>1</Value></Tag></TagSet></Tagging>"#)
                }
                ("GET", true) => Reply::xml(200, &tagging_xml(1)),
                ("PUT", true) => Reply::status(200),
                _ => Reply::status(500),
            }
        })
        .await;
        let op = TagOperation { mode: TagMode::Merge, set: vec![Tag::new("new", "1")], remove: vec![] };
        let items = vec![obj("a", None), obj("full", None), obj("same", None), obj("gone", None)];
        let (j, _) = run(tag_request(items, op), &s3.client()).await;
        assert_eq!(j.status, JobStatus::Failed);
        assert_eq!((j.total_items, j.done_items, j.failed_items), (4, 2, 2));
        assert_eq!((j.total_bytes, j.done_bytes), (0, 0), "a tag job reports no bytes");
        assert_eq!(j.dest_bucket, None);
        assert_eq!(j.label, "Tag 4 items");
        let msg = |k: &str| j.errors.iter().find(|e| e.key == k).map(|e| e.message.clone()).unwrap_or_default();
        assert!(msg("full").contains("would have 11 tags; the limit is 10"), "{}", msg("full"));
        assert_eq!(msg("gone"), plan::OBJECT_MISSING);
        let puts: Vec<String> =
            s3.requests().into_iter().filter(|r| r.method == "PUT").map(|r| r.path.trim_start_matches("/b/").to_string()).collect();
        assert_eq!(puts, ["a"], "only the object that needed a change was written");
        let body = s3.requests().into_iter().find(|r| r.method == "PUT").map(|r| String::from_utf8_lossy(&r.body).to_string());
        let body = body.unwrap_or_default();
        assert!(body.contains("<Key>t0</Key>") && body.contains("<Key>new</Key>"), "{body}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tag_replace_with_an_empty_set_deletes_the_tagging() {
        use crate::models::{TagMode, TagOperation};
        let s3 = FakeS3::start(|r| match (r.method.as_str(), r.has_query("tagging")) {
            ("HEAD", _) => Reply::with_headers(200, vec![h("Content-Length", "1")]),
            ("DELETE", true) => Reply::status(204),
            _ => Reply::status(500),
        })
        .await;
        let op = TagOperation { mode: TagMode::Replace, set: vec![], remove: vec![] };
        let (j, _) = run(tag_request(vec![obj("x", None), obj("y", None)], op), &s3.client()).await;
        assert_eq!((j.status, j.done_items), (JobStatus::Completed, 2));
        assert_eq!(s3.count(|r| r.method == "DELETE" && r.has_query("tagging")), 2);
        assert_eq!(s3.count(|r| r.method == "GET"), 0, "replace never reads the current tags");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tag_job_stops_when_the_server_does_not_support_tagging() {
        use crate::models::{Tag, TagMode, TagOperation};
        let s3 = FakeS3::start(|r| match (r.method.as_str(), r.has_query("tagging")) {
            ("HEAD", _) => Reply::with_headers(200, vec![h("Content-Length", "1")]),
            (_, true) => Reply::xml(501, "<Error><Code>NotImplemented</Code><Message>A header you provided implies functionality that is not implemented</Message></Error>"),
            _ => Reply::status(500),
        })
        .await;
        let items: Vec<JobItem> = (0..200).map(|i| obj(&format!("k{i}"), None)).collect();
        let op = TagOperation { mode: TagMode::Replace, set: vec![Tag::new("a", "b")], remove: vec![] };
        let (j, _) = run(tag_request(items, op), &s3.client()).await;
        assert_eq!(j.status, JobStatus::Failed);
        let err = j.error.clone().unwrap_or_default();
        assert!(err.contains("does not support object tags"), "{err}");
        let puts = s3.count(|r| r.method == "PUT");
        assert!(puts < 200 && j.failed_items as usize == puts, "stopped early: {puts} PUTs, {} failed", j.failed_items);
    }

    /// Delete job of keys k1..k3 whose DeleteObjects answer is `answer`; `exists` says which keys a
    /// follow-up HeadObject still finds.
    async fn delete_job(answer: String, exists: &'static [&'static str]) -> (Job, FakeS3) {
        let s3 = FakeS3::start(move |r| {
            if is_delete(r) {
                Reply::xml(200, &answer)
            } else if r.method == "HEAD" {
                let key = r.path.trim_start_matches("/b/");
                if exists.contains(&key) {
                    Reply::with_headers(200, vec![h("Content-Length", "3"), h("ETag", "\"x\"")])
                } else {
                    Reply::status(404)
                }
            } else {
                Reply::status(500)
            }
        })
        .await;
        let req = request(JobKind::Delete, vec![obj("k1", None), obj("k2", None), obj("k3", None)]);
        let (j, _) = run(req, &s3.client()).await;
        (j, s3)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn delete_job_trusts_only_confirmed_keys() {
        // All confirmed.
        let (j, s3) = delete_job(delete_result(&["k1", "k2", "k3"], &[]), &[]).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Completed, 3, 0));
        assert_eq!(s3.count(|r| r.method == "HEAD"), 0, "no lookups when everything is confirmed");
        let sent = s3.requests().into_iter().find(is_delete).expect("delete sent");
        assert!(String::from_utf8_lossy(&sent.body).contains("<Quiet>false</Quiet>"), "Quiet is off");
        // k2 missing from both lists and still there: a per-object failure, job failed.
        let (j, _) = delete_job(delete_result(&["k1", "k3"], &[]), &["k2"]).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Failed, 2, 1));
        assert_eq!(j.errors[0].key, "k2");
        assert_eq!(j.errors[0].message, engine::DELETE_NOT_CONFIRMED);
        // k2 missing from both lists but gone (HeadObject 404): deleted.
        let (j, s3) = delete_job(delete_result(&["k1", "k3"], &[]), &[]).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Completed, 3, 0));
        assert_eq!(s3.count(|r| r.method == "HEAD" && r.path == "/b/k2"), 1);
        // An error without a key: nothing in the batch counts as done.
        let (j, _) = delete_job(delete_result(&["k1", "k2", "k3"], &[(None, "InternalError")]), &[]).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Failed, 0, 3));
        assert!(j.errors[0].message.contains("without naming the object"), "{}", j.errors[0].message);
        // An error with a key fails that key only.
        let (j, _) = delete_job(delete_result(&["k1", "k3"], &[(Some("k2"), "AccessDenied")]), &[]).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Failed, 2, 1));
        assert_eq!(j.errors[0].message, "AccessDenied: fabricated");
        // Duplicate entries in the answer change nothing.
        let (j, _) = delete_job(delete_result(&["k1", "k1", "k2", "k3", "k3"], &[]), &[]).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Completed, 3, 0));
    }

    /// A move of `s/a` -> `d/a` (same bucket) whose source deletes are answered by `deletes` in
    /// turn (the last one repeats); `src_exists` is what a HeadObject of the source says after
    /// the copy.
    async fn move_job(deletes: Vec<String>, src_exists_after: bool) -> (Job, FakeS3) {
        let n = std::sync::atomic::AtomicUsize::new(0);
        let s3 = FakeS3::start(move |r| {
            let etag = h("ETag", "\"e1\"");
            match (r.method.as_str(), r.path.as_str()) {
                ("HEAD", "/b/s/a") => {
                    let deleting = n.load(Ordering::SeqCst) > 0;
                    if deleting && !src_exists_after {
                        Reply::status(404)
                    } else {
                        Reply::with_headers(200, vec![h("Content-Length", "5"), etag])
                    }
                }
                ("HEAD", "/b/d/a") => Reply::with_headers(200, vec![h("Content-Length", "5"), etag]),
                ("PUT", "/b/d/a") if r.header("x-amz-copy-source").is_some() => Reply::xml(
                    200,
                    r#"<CopyObjectResult><ETag>"e1"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>"#,
                ),
                ("POST", "/b" | "/b/") if r.has_query("delete") => {
                    let i = n.fetch_add(1, Ordering::SeqCst).min(deletes.len() - 1);
                    Reply::xml(200, &deletes[i])
                }
                _ => Reply::status(500),
            }
        })
        .await;
        let (j, _) = run(request(JobKind::Move, vec![obj("s/a", Some("d/a"))]), &s3.client()).await;
        (j, s3)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn move_counts_a_source_as_moved_only_when_its_delete_is_confirmed() {
        let (j, s3) = move_job(vec![delete_result(&["s/a"], &[])], true).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Completed, 1, 0));
        let del = s3.requests().into_iter().find(is_delete).expect("delete sent");
        assert!(String::from_utf8_lossy(&del.body).contains("<ETag>"), "conditional on the copied ETag");
        // Not mentioned and still there: the copy exists, the original remains, never "moved".
        let (j, _) = move_job(vec![delete_result(&[], &[])], true).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Failed, 0, 1));
        let m = &j.errors[0].message;
        assert!(m.contains("did not confirm the delete") && m.contains("The copy exists and the original remains"), "{m}");
        // An unattributable error: same.
        let (j, _) = move_job(vec![delete_result(&["s/a"], &[(None, "InternalError")])], true).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Failed, 0, 1));
        assert!(j.errors[0].message.contains("The copy exists and the original remains"));
        // Not mentioned but gone: moved.
        let (j, _) = move_job(vec![delete_result(&[], &[])], false).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Completed, 1, 0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn move_retry_without_etag_follows_the_same_rule() {
        let rejected = delete_result(&[], &[(Some("s/a"), "NotImplemented")]);
        // Retried without the condition, then confirmed.
        let (j, s3) = move_job(vec![rejected.clone(), delete_result(&["s/a"], &[])], true).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Completed, 1, 0));
        let dels: Vec<Req> = s3.requests().into_iter().filter(is_delete).collect();
        assert_eq!(dels.len(), 2);
        assert!(String::from_utf8_lossy(&dels[0].body).contains("<ETag>"));
        assert!(!String::from_utf8_lossy(&dels[1].body).contains("<ETag>"), "retry is unconditional");
        // Retried, but the retry is not confirmed and the source is still there: failure.
        let (j, s3) = move_job(vec![rejected, delete_result(&[], &[])], true).await;
        assert_eq!((j.status, j.done_items, j.failed_items), (JobStatus::Failed, 0, 1));
        assert!(j.errors[0].message.contains("The copy exists and the original remains"));
        assert_eq!(s3.count(is_delete), 2, "retried once only");
    }

    fn list_xml(keys: &[(&str, Option<&str>)], is_truncated: Option<bool>, next: Option<&str>) -> String {
        let mut x = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name>"#);
        if let Some(t) = is_truncated {
            x.push_str(&format!("<IsTruncated>{t}</IsTruncated>"));
        }
        if let Some(n) = next {
            x.push_str(&format!("<NextContinuationToken>{n}</NextContinuationToken>"));
        }
        for (k, etag) in keys {
            x.push_str(&format!("<Contents><Key>{k}</Key><Size>5</Size>"));
            if let Some(e) = etag {
                x.push_str(&format!("<ETag>{e}</ETag>"));
            }
            x.push_str("</Contents>");
        }
        x.push_str("</ListBucketResult>");
        x
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn listing_follows_a_token_even_without_is_truncated() {
        let s3 = FakeS3::start(|r| {
            if r.method == "GET" && r.has_query("list-type") {
                if r.query.contains("continuation-token=T1") {
                    Reply::xml(200, &list_xml(&[("p/2", Some("\"2\""))], None, None))
                } else {
                    Reply::xml(200, &list_xml(&[("p/1", Some("\"1\""))], None, Some("T1")))
                }
            } else if is_delete(r) {
                let keys = r.xml_keys();
                let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
                Reply::xml(200, &delete_result(&keys, &[]))
            } else {
                Reply::status(500)
            }
        })
        .await;
        let req = request(JobKind::Delete, vec![JobItem { from: "p/".into(), to: None, is_prefix: true }]);
        let (j, _) = run(req, &s3.client()).await;
        assert_eq!((j.status, j.total_items, j.done_items), (JobStatus::Completed, 2, 2));
        let del = s3.requests().into_iter().find(is_delete).expect("delete");
        assert_eq!(del.xml_keys(), vec!["p/1", "p/2"], "the second page was listed");

        // A server that hands out the same token forever: the job fails before any change.
        let s3 = FakeS3::start(|r| {
            if r.method == "GET" && r.has_query("list-type") {
                Reply::xml(200, &list_xml(&[("p/1", Some("\"1\""))], Some(true), Some("SAME")))
            } else {
                Reply::status(500)
            }
        })
        .await;
        let req = request(JobKind::Delete, vec![JobItem { from: "p/".into(), to: None, is_prefix: true }]);
        let (j, _) = run(req, &s3.client()).await;
        assert_eq!(j.status, JobStatus::Failed);
        assert!(j.error.as_deref().unwrap_or_default().contains("same continuation token"), "{:?}", j.error);
        assert_eq!(s3.count(is_delete), 0);
        assert_eq!(s3.count(|r| r.has_query("list-type")), 2);
    }

    /// A prefix move whose listing has no ETags; `head_etag` is what HeadObject then says.
    async fn move_without_listing_etag(head_etag: Option<&'static str>) -> (Job, FakeS3) {
        let s3 = FakeS3::start(move |r| match (r.method.as_str(), r.path.as_str()) {
            ("GET", "/b" | "/b/") if r.has_query("list-type") => Reply::xml(200, &list_xml(&[("s/x", None)], Some(false), None)),
            ("HEAD", "/b/s/x") | ("HEAD", "/b/d/x") => {
                let mut hs = vec![h("Content-Length", "5")];
                if let Some(e) = head_etag {
                    hs.push(h("ETag", e));
                }
                Reply::with_headers(200, hs)
            }
            ("PUT", "/b/d/x") => Reply::xml(
                200,
                r#"<CopyObjectResult><ETag>"e"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>"#,
            ),
            ("POST", "/b" | "/b/") if r.has_query("delete") => Reply::xml(200, &delete_result(&["s/x"], &[])),
            _ => Reply::status(500),
        })
        .await;
        let req = request(JobKind::Move, vec![JobItem { from: "s/".into(), to: Some("d/".into()), is_prefix: true }]);
        let (j, _) = run(req, &s3.client()).await;
        (j, s3)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn move_needs_an_etag_before_anything_changes() {
        // No ETag anywhere: not moved, nothing written or deleted.
        let (j, s3) = move_without_listing_etag(None).await;
        assert_eq!((j.status, j.total_items, j.done_items, j.failed_items), (JobStatus::Failed, 1, 0, 1));
        assert_eq!(j.errors[0].message, engine::NO_ETAG_FOR_MOVE);
        assert_eq!(s3.count(|r| r.method == "PUT"), 0, "no copy");
        assert_eq!(s3.count(is_delete), 0, "no delete");
        // The listing had none, HeadObject has one: the move goes ahead, pinned to it.
        let (j, s3) = move_without_listing_etag(Some("\"h1\"")).await;
        assert_eq!((j.status, j.done_items), (JobStatus::Completed, 1));
        let put = s3.requests().into_iter().find(|r| r.method == "PUT").expect("copy");
        assert_eq!(put.header("x-amz-copy-source-if-match"), Some("\"h1\""));
        let del = s3.requests().into_iter().find(is_delete).expect("delete");
        assert!(String::from_utf8_lossy(&del.body).contains("<ETag>&quot;h1&quot;</ETag>") || String::from_utf8_lossy(&del.body).contains("<ETag>\"h1\"</ETag>"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_panicking_job_still_finishes() {
        let hook: AfterListingHook = Arc::new(|_| Box::pin(async { panic!("injected fault") }));
        let m = JobManager::with_tuning(Arc::new(NoopJobSink), JobTuning { after_listing: Some(hook), ..JobTuning::default() });
        let conf = aws_sdk_s3::Config::builder().behavior_version(aws_sdk_s3::config::BehaviorVersion::latest()).build();
        let client = Client::from_conf(conf);
        // A single-key delete needs no request before the hook (delete keys are not looked up).
        let id = m.start(request(JobKind::Delete, vec![obj("k", None)]), client, None).expect("start");
        let j = tokio::time::timeout(Duration::from_secs(10), m.wait(&id)).await.expect("not stuck").expect("known");
        assert_eq!((j.status, j.phase), (JobStatus::Failed, JobPhase::Done));
        assert!(j.finished_at.is_some());
        assert!(j.error.as_deref().unwrap_or_default().contains("injected fault"), "{:?}", j.error);
        assert!(!m.has_active());
        assert_eq!(m.running_count(), 0, "run slot released");
    }

    fn job() -> Job {
        Job {
            id: "j".into(),
            kind: JobKind::Move,
            src_bucket: "a".into(),
            dest_bucket: Some("a".into()),
            label: String::new(),
            phase: JobPhase::Working,
            total_items: 0,
            done_items: 0,
            skipped_items: 0,
            failed_items: 0,
            total_bytes: 0,
            done_bytes: 0,
            status: JobStatus::Running,
            error: None,
            errors: Vec::new(),
            started_at: now_iso(),
            finished_at: None,
        }
    }

    fn entry() -> JobEntry {
        JobEntry {
            seq: 0,
            record: Mutex::new(job()),
            cancel: CancellationToken::new(),
            finished: CancellationToken::new(),
        }
    }

    #[test]
    fn counters_and_error_cap() {
        let e = entry();
        e.lock().total_items = 130;
        for i in 0..70 {
            e.fail(&format!("k{i}"), "boom".into());
        }
        for _ in 0..50 {
            e.done(10);
        }
        for _ in 0..10 {
            e.skipped();
        }
        let j = e.snapshot();
        assert_eq!((j.failed_items, j.done_items, j.skipped_items, j.done_bytes), (70, 50, 10, 500));
        assert_eq!(j.errors.len(), JOB_MAX_ERRORS, "only the first 50 errors are kept");
        assert_eq!(j.errors[0].key, "k0");
        assert_eq!(j.errors[49].key, "k49");
        assert_eq!(j.done_items + j.skipped_items + j.failed_items, j.total_items);
    }

    #[test]
    fn final_status_rule() {
        let run = |total, done, skipped, failed, result: AppResult<()>, cancel| {
            let mut j = job();
            (j.total_items, j.done_items, j.skipped_items, j.failed_items) = (total, done, skipped, failed);
            finish(&mut j, result, cancel);
            assert_eq!(j.phase, JobPhase::Done);
            assert!(j.finished_at.is_some());
            (j.status, j.error)
        };
        assert_eq!(run(3, 3, 0, 0, Ok(()), false), (JobStatus::Completed, None));
        assert_eq!(run(3, 1, 2, 0, Ok(()), false), (JobStatus::Completed, None), "skips are not failures");
        assert_eq!(run(3, 2, 0, 1, Ok(()), false), (JobStatus::Failed, None));
        assert_eq!(run(3, 1, 0, 0, Ok(()), true), (JobStatus::Cancelled, None));
        assert_eq!(run(3, 3, 0, 0, Ok(()), true), (JobStatus::Completed, None), "cancel after the last object");
        assert_eq!(run(3, 0, 0, 0, Err(AppError::cancelled()), false), (JobStatus::Cancelled, None));
        let (s, e) = run(5, 0, 0, 0, Err(AppError::invalid("Two source objects ...")), false);
        assert_eq!(s, JobStatus::Failed);
        assert_eq!(e.as_deref(), Some("Two source objects ..."));
    }

    #[tokio::test]
    async fn manager_rejects_invalid_and_tracks_activity() {
        let m = JobManager::new(Arc::new(NoopJobSink));
        let conf = aws_sdk_s3::Config::builder().behavior_version(aws_sdk_s3::config::BehaviorVersion::latest()).build();
        let client = Client::from_conf(conf);
        let bad = JobRequest {
            kind: JobKind::Copy,
            src_bucket: "a".into(),
            dest_bucket: Some("a".into()),
            items: vec![crate::models::JobItem { from: "x/".into(), to: Some("x/y/".into()), is_prefix: true }],
            on_conflict: ConflictPolicy::Skip,
            tags: None,
        };
        let e = m.start(bad.clone(), client.clone(), Some(client.clone())).expect_err("into itself");
        assert_eq!(e.code, crate::error::ErrorCode::InvalidInput);
        let mut no_dest = bad;
        no_dest.items[0].to = Some("z/".into());
        let e = m.start(no_dest, client.clone(), None).expect_err("no dest client");
        assert_eq!(e.code, crate::error::ErrorCode::InvalidInput);
        assert!(m.list().is_empty() && !m.has_active());
        assert_eq!(m.cancel("nope").expect_err("unknown").code, crate::error::ErrorCode::InvalidInput);
        assert!(m.remove("nope").is_ok());
    }
}
