//! Background object operations ("jobs"): delete, copy, move (and rename = move).
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use aws_sdk_s3::Client;
use dashmap::DashMap;
use futures::future::BoxFuture;
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
    if req.kind != JobKind::Delete && dest.is_none() {
        return Err(AppError::invalid("destBucket is required"));
    }
    let cancel = CancellationToken::new();
    let tuning = JobTuning::default();
    let ctx = Ctx { req, src, dest, cancel: &cancel, tuning: &tuning };
    let (exp, mut truncated) = engine::expand(&ctx, true, Some(JOB_PREVIEW_CAP), &|_| {}).await?;
    let same_bucket = req.dest_bucket.as_deref() == Some(req.src_bucket.as_str());
    plan::check_collisions(&exp.work, same_bucket).map_err(AppError::invalid)?;
    let conflicts = if req.kind == JobKind::Delete {
        0
    } else {
        let (existing, t) = engine::existing_dests(&ctx, &exp, Some(JOB_PREVIEW_CAP)).await?;
        truncated |= t;
        existing.len() as u64
    };
    Ok(JobPreview { objects: exp.work.len() as u64, bytes: exp.bytes(), conflicts, truncated })
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
        if req.kind != JobKind::Delete && dest.is_none() {
            return Err(AppError::invalid("destBucket is required"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = Job {
            id: id.clone(),
            kind: req.kind,
            src_bucket: req.src_bucket.clone(),
            dest_bucket: if req.kind == JobKind::Delete { None } else { req.dest_bucket.clone() },
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
                let r = self.execute(&entry, &req, &src, dest.as_ref()).await;
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
        let transfer = req.kind != JobKind::Delete;

        // ---- listing phase: nothing is changed here ----
        let on_page = |n: u64| entry.lock().total_items += n;
        let (exp, _) = engine::expand(&ctx, transfer, None, &on_page).await?;
        {
            let mut j = entry.lock();
            j.total_items = (exp.work.len() + exp.missing.len()) as u64;
            j.total_bytes = exp.bytes();
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
        if transfer {
            engine::run_transfer(&ctx, entry, &exp.work, &existing).await;
        } else {
            engine::run_delete(&ctx, entry, &exp.work).await;
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
