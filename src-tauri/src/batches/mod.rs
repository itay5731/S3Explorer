//! Folder transfers ("batches"): many ordinary transfers started together and reported as one.
//!
//! A batch plans first (status `planning`: walk the local folder or list the prefix, see
//! [`plan`]), then feeds one transfer per file into the normal [`TransferManager`] queue, in
//! path order, so part size, parallel parts, resume, `.part` handling, `maxConcurrentTransfers`
//! and FIFO order all apply unchanged. There is no second queue: the batch never holds a run
//! slot of its own. Each transfer carries `batchId`; its cancel token is a child of the batch's,
//! and a [`TransferObserver`] folds its final state into the batch counters.
//!
//! Events (`batch:progress` in the app, through a [`BatchSink`]): first `planning`, then
//! `queued`, `running`, and a final event carrying `finishedAt`. Status changes are sent at
//! once; other changes at most every 100 ms. The ticker stops before the final event.

pub mod localname;
pub mod plan;

use std::collections::{HashSet, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use aws_sdk_s3::Client;
use dashmap::DashMap;
use futures::FutureExt;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::models::{
    last_segment, now_iso, Batch, BatchError, BatchKind, BatchPlanRequest, BatchPreview, BatchStatus, ConflictPolicy,
    Transfer, TransferStatus, BATCH_MAX_ERRORS,
};
use crate::transfers::{BatchLink, TransferManager, TransferObserver};
use plan::{fmt_count, Plan};

const TICK: Duration = Duration::from_millis(100);
const RATE_WINDOW: Duration = Duration::from_secs(2);

/// Start of the error of a batch download under `skip` whose file appeared after planning (see
/// `transfers::download`); such a file counts as skipped, not failed.
const EXISTS_PREFIX: &str = "A file already exists at ";

/// Receives `Batch` snapshots (the Tauri app emits them as `batch:progress`).
pub trait BatchSink: Send + Sync + 'static {
    fn emit(&self, batch: &Batch);
}

/// A sink that drops every event.
pub struct NoopBatchSink;
impl BatchSink for NoopBatchSink {
    fn emit(&self, _batch: &Batch) {}
}

impl<F: Fn(&Batch) + Send + Sync + 'static> BatchSink for F {
    fn emit(&self, batch: &Batch) {
        self(batch)
    }
}

/// Byte accounting across the batch's transfers.
#[derive(Default)]
struct Bytes {
    /// Transfers running now (their live `transferredBytes` is added on every tick).
    running: HashSet<String>,
    /// Bytes moved by transfers that finished (completed, failed or cancelled).
    finished: u64,
}

pub struct BatchEntry {
    seq: u64,
    record: Mutex<Batch>,
    cancel: CancellationToken,
    finished: CancellationToken,
    /// When the last event was sent; held while a snapshot is taken and sent (see jobs).
    emitted: Mutex<Option<Instant>>,
    bytes: Mutex<Bytes>,
    /// Transfers started and not finished yet.
    outstanding: AtomicUsize,
    idle: Notify,
    /// Ids of the batch's transfers, in start order.
    transfer_ids: Mutex<Vec<String>>,
    /// Batch download under `skip`: a file that appeared after planning counts as skipped.
    no_replace: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl BatchEntry {
    fn lock(&self) -> MutexGuard<'_, Batch> {
        lock(&self.record)
    }
    fn snapshot(&self) -> Batch {
        self.lock().clone()
    }
    fn status(&self) -> BatchStatus {
        self.lock().status
    }
    /// Sends the current state now (status changes, first and last events are never throttled).
    fn publish(&self, sink: &dyn BatchSink) {
        let mut at = lock(&self.emitted);
        sink.emit(&self.snapshot());
        *at = Some(Instant::now());
    }
}

/// Folds the final state of one of the batch's transfers into its counters. A transfer
/// cancelled because the batch was cancelled is not counted (the batch ends `cancelled`); one
/// cancelled on its own while the batch goes on is a failure, so the batch cannot end
/// `completed` with a file missing.
fn apply_finished(b: &mut Batch, t: &Transfer, batch_cancelled: bool, no_replace: bool) {
    let path = match b.kind {
        BatchKind::Download => t.key.clone(),
        BatchKind::Upload => t.local_path.clone(),
    };
    match t.status {
        TransferStatus::Completed => b.done_files += 1,
        TransferStatus::Failed if no_replace && t.error.as_deref().is_some_and(|e| e.starts_with(EXISTS_PREFIX)) => {
            b.skipped_files += 1;
        }
        TransferStatus::Failed => {
            let message = t.error.clone().unwrap_or_else(|| "Failed".to_string());
            push_failure(b, path, message);
        }
        TransferStatus::Cancelled if batch_cancelled => {}
        TransferStatus::Cancelled => push_failure(b, path, "Cancelled".to_string()),
        TransferStatus::Queued | TransferStatus::Running => {}
    }
}

fn push_failure(b: &mut Batch, path: String, message: String) {
    b.failed_files += 1;
    if b.errors.len() < BATCH_MAX_ERRORS {
        b.errors.push(BatchError { path, message });
    }
}

/// The final state: `cancelled` when cancelled (or cancel was requested and not every file was
/// processed), `failed` on a planning error or when any file failed, otherwise `completed`.
fn finish(b: &mut Batch, result: AppResult<()>, cancel_requested: bool) {
    b.finished_at = Some(now_iso());
    b.bytes_per_sec = 0;
    let processed = b.done_files + b.skipped_files + b.failed_files;
    b.status = match result {
        Err(e) if e.is_cancelled() => BatchStatus::Cancelled,
        Err(e) => {
            b.error = Some(e.message);
            BatchStatus::Failed
        }
        Ok(()) if cancel_requested && processed < b.total_files => BatchStatus::Cancelled,
        Ok(()) if b.failed_files > 0 => BatchStatus::Failed,
        Ok(()) => BatchStatus::Completed,
    };
}

/// Applies a finished plan to the record: totals, planned failures, skipped conflicts.
/// Returns the files to transfer, in path order.
fn apply_plan(b: &mut Batch, plan: Plan, policy: ConflictPolicy) -> Vec<plan::PlannedFile> {
    let (send, skip): (Vec<_>, Vec<_>) =
        plan.files.into_iter().partition(|f| policy == ConflictPolicy::Overwrite || !f.exists);
    b.total_files = (send.len() + skip.len() + plan.failures.len()) as u64;
    b.skipped_files = skip.len() as u64;
    b.total_bytes = send.iter().map(|f| f.size).sum();
    for f in plan.failures {
        push_failure(b, f.path, f.message);
    }
    if b.kind == BatchKind::Upload {
        b.label = format!("{} ({} files)", b.label, fmt_count(b.total_files));
    }
    send
}

/// Bridges the transfer manager's per-transfer callbacks to one batch.
struct Observer {
    entry: Arc<BatchEntry>,
    sink: Arc<dyn BatchSink>,
}

impl TransferObserver for Observer {
    fn running(&self, transfer_id: &str) {
        lock(&self.entry.bytes).running.insert(transfer_id.to_string());
        let changed = {
            let mut b = self.entry.lock();
            let first = b.status == BatchStatus::Queued;
            if first {
                b.status = BatchStatus::Running;
            }
            first
        };
        if changed {
            self.entry.publish(self.sink.as_ref());
        }
    }

    fn finished(&self, t: &Transfer) {
        {
            let mut bytes = lock(&self.entry.bytes);
            bytes.running.remove(&t.id);
            bytes.finished += t.transferred_bytes;
        }
        apply_finished(&mut self.entry.lock(), t, self.entry.cancel.is_cancelled(), self.entry.no_replace);
        if self.entry.outstanding.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.entry.idle.notify_waiters();
        }
    }
}

pub struct BatchManager {
    entries: DashMap<String, Arc<BatchEntry>>,
    transfers: Arc<TransferManager>,
    sink: Arc<dyn BatchSink>,
    seq: AtomicU64,
}

/// "photos/" for `C:\Users\me\photos`; the path itself when it has no last component.
fn folder_name(local: &str) -> String {
    Path::new(local).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| local.to_string())
}

fn label(req: &BatchPlanRequest) -> String {
    match req.kind {
        BatchKind::Upload => format!("Upload {}/", folder_name(&req.local_path)),
        BatchKind::Download => {
            let name = last_segment(&req.prefix);
            let name = if name.is_empty() { req.prefix.clone() } else { format!("{name}/") };
            format!("Download {name} to {}", req.local_path)
        }
    }
}

/// Plans `req` and reports what it would do, changing nothing.
pub async fn preview(req: &BatchPlanRequest, client: &Client) -> AppResult<BatchPreview> {
    let plan = plan::plan(req, client, &CancellationToken::new(), true).await?;
    Ok(plan.preview())
}

impl BatchManager {
    pub fn new(transfers: Arc<TransferManager>, sink: Arc<dyn BatchSink>) -> Arc<Self> {
        Arc::new(Self { entries: DashMap::new(), transfers, sink, seq: AtomicU64::new(0) })
    }

    /// Validates `req`, creates the batch (`planning`) and returns its id; planning and the
    /// transfers run in the background. Must be called within a Tokio runtime.
    pub fn start(self: &Arc<Self>, req: BatchPlanRequest, client: Client) -> AppResult<String> {
        plan::validate(&req)?;
        let id = uuid::Uuid::new_v4().to_string();
        let record = Batch {
            id: id.clone(),
            kind: req.kind,
            bucket: req.bucket.clone(),
            prefix: req.prefix.clone(),
            local_path: req.local_path.clone(),
            label: label(&req),
            total_files: 0,
            done_files: 0,
            skipped_files: 0,
            failed_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            bytes_per_sec: 0,
            status: BatchStatus::Planning,
            error: None,
            errors: Vec::new(),
            started_at: now_iso(),
            finished_at: None,
        };
        let entry = Arc::new(BatchEntry {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            record: Mutex::new(record),
            cancel: CancellationToken::new(),
            finished: CancellationToken::new(),
            emitted: Mutex::new(None),
            bytes: Mutex::new(Bytes::default()),
            outstanding: AtomicUsize::new(0),
            idle: Notify::new(),
            transfer_ids: Mutex::new(Vec::new()),
            no_replace: req.kind == BatchKind::Download && req.on_conflict == ConflictPolicy::Skip,
        });
        self.entries.insert(id.clone(), entry.clone());
        entry.publish(self.sink.as_ref());
        let me = self.clone();
        tokio::spawn(async move { me.run(entry, req, client).await });
        Ok(id)
    }

    async fn run(self: Arc<Self>, entry: Arc<BatchEntry>, req: BatchPlanRequest, client: Client) {
        let stop = CancellationToken::new();
        let ticker = tokio::spawn(ticker(self.sink.clone(), self.transfers.clone(), entry.clone(), stop.clone()));
        // A panic must not leave the batch active forever (has_active() blocks the updater).
        let result = AssertUnwindSafe(self.execute(&entry, &req, &client))
            .catch_unwind()
            .await
            .unwrap_or_else(|p| Err(AppError::from_panic(&*p)));
        stop.cancel();
        let _ = ticker.await;
        {
            let bytes = done_bytes(&self.transfers, &entry);
            let mut b = entry.lock();
            b.done_bytes = b.done_bytes.max(bytes);
            finish(&mut b, result, entry.cancel.is_cancelled());
        }
        entry.publish(self.sink.as_ref());
        entry.finished.cancel();
    }

    async fn execute(&self, entry: &Arc<BatchEntry>, req: &BatchPlanRequest, client: &Client) -> AppResult<()> {
        // ---- planning: nothing is transferred or written yet ----
        let check_existing = req.kind == BatchKind::Download || req.on_conflict == ConflictPolicy::Skip;
        let plan = plan::plan(req, client, &entry.cancel, check_existing).await?;
        if let Some(e) = &plan.limit_error {
            return Err(AppError::invalid(e.clone()));
        }
        let files = apply_plan(&mut entry.lock(), plan, req.on_conflict);
        if entry.cancel.is_cancelled() {
            return Err(AppError::cancelled());
        }
        if files.is_empty() {
            return Ok(());
        }
        entry.lock().status = BatchStatus::Queued;
        entry.publish(self.sink.as_ref());

        // ---- transfers, in path order, into the normal queue ----
        let observer: Arc<dyn TransferObserver> = Arc::new(Observer { entry: entry.clone(), sink: self.sink.clone() });
        let batch_id = entry.lock().id.clone();
        for (i, f) in files.into_iter().enumerate() {
            if entry.cancel.is_cancelled() {
                break;
            }
            let link = BatchLink { batch_id: batch_id.clone(), cancel: entry.cancel.clone(), observer: observer.clone() };
            entry.outstanding.fetch_add(1, Ordering::AcqRel);
            let started = match req.kind {
                BatchKind::Upload => {
                    Ok(self.transfers.start_batch_upload(client.clone(), &req.bucket, &f.key, f.local, link))
                }
                BatchKind::Download => {
                    let no_replace = req.on_conflict == ConflictPolicy::Skip;
                    self.transfers.start_batch_download(client.clone(), &req.bucket, &f.key, f.local, no_replace, link)
                }
            };
            match started {
                Ok(id) => lock(&entry.transfer_ids).push(id),
                Err(e) => {
                    entry.outstanding.fetch_sub(1, Ordering::AcqRel);
                    push_failure(&mut entry.lock(), f.key.clone(), e.message);
                }
            }
            // Thousands of starts in a row: let other tasks (and the transfers) run.
            if i % 256 == 255 {
                tokio::task::yield_now().await;
            }
        }
        // ---- wait for every started transfer to reach its final state ----
        loop {
            let idle = entry.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if entry.outstanding.load(Ordering::Acquire) == 0 {
                break;
            }
            idle.await;
        }
        Ok(())
    }

    /// Cancels the batch's queued and running transfers (cooperatively; finished files stay)
    /// and stops planning or starting more. `InvalidInput` for an unknown id; no-op once finished.
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let entry = self.entries.get(id).map(|e| e.clone()).ok_or_else(|| AppError::invalid("Unknown batch id"))?;
        entry.cancel.cancel();
        Ok(())
    }

    /// Forgets a finished batch and its (finished) transfers. `InvalidInput` while
    /// planning/queued/running; unknown id is a no-op.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let Some(entry) = self.entries.get(id).map(|e| e.clone()) else {
            return Ok(());
        };
        if entry.status().is_active() {
            return Err(AppError::invalid("Folder transfer is still active; cancel it first"));
        }
        self.entries.remove(id);
        for t in lock(&entry.transfer_ids).iter() {
            let _ = self.transfers.remove(t);
        }
        Ok(())
    }

    /// All known batches, oldest first.
    pub fn list(&self) -> Vec<Batch> {
        let mut v: Vec<(u64, Batch)> = self.entries.iter().map(|e| (e.seq, e.snapshot())).collect();
        v.sort_by_key(|(s, _)| *s);
        v.into_iter().map(|(_, b)| b).collect()
    }

    pub fn get(&self, id: &str) -> Option<Batch> {
        self.entries.get(id).map(|e| e.snapshot())
    }

    /// Ids of the batch's transfers, in start (path) order.
    pub fn transfer_ids(&self, id: &str) -> Vec<String> {
        self.entries.get(id).map(|e| lock(&e.transfer_ids).clone()).unwrap_or_default()
    }

    /// True while any batch is planning, queued or running (the updater refuses to install then).
    pub fn has_active(&self) -> bool {
        self.entries.iter().any(|e| e.status().is_active())
    }

    /// Waits until the batch reaches a final state (after its final event) and returns it.
    pub async fn wait(&self, id: &str) -> Option<Batch> {
        let entry = self.entries.get(id).map(|e| e.clone())?;
        entry.finished.cancelled().await;
        Some(entry.snapshot())
    }
}

/// Bytes moved so far: finished transfers plus the live count of running ones.
fn done_bytes(tm: &TransferManager, entry: &BatchEntry) -> u64 {
    let bytes = lock(&entry.bytes);
    bytes.finished + bytes.running.iter().filter_map(|id| tm.get(id)).map(|t| t.transferred_bytes).sum::<u64>()
}

/// Updates `doneBytes` / `bytesPerSec` and emits while something changed, never within 100 ms
/// of the previous event (see the jobs ticker).
async fn ticker(sink: Arc<dyn BatchSink>, tm: Arc<TransferManager>, entry: Arc<BatchEntry>, stop: CancellationToken) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await; // immediate; the `planning` event was just sent
    let mut samples: VecDeque<(Instant, u64)> = VecDeque::new();
    let key = |b: &Batch| (b.total_files, b.done_files, b.skipped_files, b.failed_files, b.total_bytes, b.done_bytes, b.bytes_per_sec);
    // The state the first event showed: nothing to send until it changes.
    let mut last = Some(key(&entry.snapshot()));
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            _ = interval.tick() => {}
        }
        let now = Instant::now();
        let bytes = done_bytes(&tm, &entry);
        let active = entry.status() == BatchStatus::Running;
        samples.push_back((now, bytes));
        while samples.len() > 2 && samples.front().is_some_and(|(t, _)| now.duration_since(*t) > RATE_WINDOW) {
            samples.pop_front();
        }
        let bps = match samples.front() {
            Some((t0, b0)) if active => {
                let dt = now.duration_since(*t0).as_secs_f64();
                if dt > 0.05 {
                    (bytes.saturating_sub(*b0) as f64 / dt) as u64
                } else {
                    0
                }
            }
            _ => 0,
        };
        let mut at = lock(&entry.emitted);
        if at.is_some_and(|t| t.elapsed() < TICK) {
            continue;
        }
        let snap = {
            let mut b = entry.lock();
            b.done_bytes = b.done_bytes.max(bytes);
            b.bytes_per_sec = bps;
            b.clone()
        };
        let k = key(&snap);
        if last != Some(k) {
            last = Some(k);
            sink.emit(&snap);
            *at = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TransferKind;
    use plan::PlannedFile;

    fn batch(kind: BatchKind) -> Batch {
        Batch {
            id: "b".into(),
            kind,
            bucket: "bk".into(),
            prefix: "p/".into(),
            local_path: "/x".into(),
            label: "Upload x/".into(),
            total_files: 0,
            done_files: 0,
            skipped_files: 0,
            failed_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            bytes_per_sec: 0,
            status: BatchStatus::Running,
            error: None,
            errors: Vec::new(),
            started_at: now_iso(),
            finished_at: None,
        }
    }

    fn transfer(status: TransferStatus, error: Option<&str>) -> Transfer {
        Transfer {
            id: "t".into(),
            kind: TransferKind::Download,
            batch_id: Some("b".into()),
            bucket: "bk".into(),
            key: "p/k".into(),
            local_path: "/x/k".into(),
            total_bytes: 5,
            transferred_bytes: 5,
            parts_total: 1,
            parts_done: 1,
            bytes_per_sec: 0,
            status,
            error: error.map(str::to_string),
            started_at: now_iso(),
            finished_at: Some(now_iso()),
        }
    }

    fn pf(key: &str, size: u64, exists: bool) -> PlannedFile {
        PlannedFile { key: key.into(), local: key.into(), size, exists }
    }

    #[test]
    fn counters_add_up_and_status_follows_the_rule() {
        let mut b = batch(BatchKind::Download);
        let plan = Plan {
            files: vec![pf("a", 1, false), pf("b", 2, true), pf("c", 3, false), pf("d", 4, false)],
            failures: vec![BatchError { path: "x".into(), message: "collision".into() }],
            ..Plan::default()
        };
        let send = apply_plan(&mut b, plan, ConflictPolicy::Skip);
        assert_eq!(send.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), ["a", "c", "d"]);
        assert_eq!((b.total_files, b.skipped_files, b.failed_files, b.total_bytes), (5, 1, 1, 8));
        apply_finished(&mut b, &transfer(TransferStatus::Completed, None), false, true);
        apply_finished(&mut b, &transfer(TransferStatus::Failed, Some("boom")), false, true);
        // Appeared after planning under skip: skipped, not failed.
        apply_finished(&mut b, &transfer(TransferStatus::Failed, Some("A file already exists at /x/k; it was left unchanged")), false, true);
        assert_eq!((b.done_files, b.skipped_files, b.failed_files), (1, 2, 2));
        assert_eq!(b.done_files + b.skipped_files + b.failed_files, b.total_files);
        assert_eq!(b.errors.iter().map(|e| (e.path.as_str(), e.message.as_str())).collect::<Vec<_>>(), [("x", "collision"), ("p/k", "boom")]);
        let mut done = b.clone();
        finish(&mut done, Ok(()), false);
        assert_eq!(done.status, BatchStatus::Failed, "any failed file fails the batch");
        assert!(done.finished_at.is_some() && done.error.is_none());

        // Overwrite: conflicts are transferred.
        let mut b = batch(BatchKind::Upload);
        let plan = Plan { files: vec![pf("a", 1, true), pf("b", 2, false)], ..Plan::default() };
        let send = apply_plan(&mut b, plan, ConflictPolicy::Overwrite);
        assert_eq!((send.len(), b.total_files, b.skipped_files, b.total_bytes), (2, 2, 0, 3));
        assert_eq!(b.label, "Upload x/ (2 files)");
        let mut up = transfer(TransferStatus::Completed, None);
        up.kind = TransferKind::Upload;
        apply_finished(&mut b, &up, false, false);
        apply_finished(&mut b, &up, false, false);
        let mut ok = b.clone();
        finish(&mut ok, Ok(()), false);
        assert_eq!(ok.status, BatchStatus::Completed);
        // A failed upload names the local path.
        let mut failed = b.clone();
        up.status = TransferStatus::Failed;
        up.error = Some("denied".into());
        apply_finished(&mut failed, &up, false, false);
        assert_eq!(failed.errors[0].path, "/x/k");
        // The exists prefix only means "skipped" for a no-replace download batch.
        let mut b = batch(BatchKind::Download);
        apply_finished(&mut b, &transfer(TransferStatus::Failed, Some("A file already exists at /x")), false, false);
        assert_eq!(b.failed_files, 1);
    }

    #[test]
    fn cancel_accounting() {
        let mut b = batch(BatchKind::Download);
        b.total_files = 3;
        apply_finished(&mut b, &transfer(TransferStatus::Completed, None), false, false);
        // Cancelled with the batch: not counted.
        apply_finished(&mut b, &transfer(TransferStatus::Cancelled, None), true, false);
        assert_eq!((b.done_files, b.failed_files), (1, 0));
        let mut c = b.clone();
        finish(&mut c, Ok(()), true);
        assert_eq!(c.status, BatchStatus::Cancelled);
        // Cancelled alone while the batch goes on: a failure.
        apply_finished(&mut b, &transfer(TransferStatus::Cancelled, None), false, false);
        assert_eq!(b.failed_files, 1);
        assert_eq!(b.errors[0].message, "Cancelled");
        // Cancel requested after every file was processed: the real outcome stands.
        let mut all = batch(BatchKind::Upload);
        all.total_files = 1;
        all.done_files = 1;
        finish(&mut all, Ok(()), true);
        assert_eq!(all.status, BatchStatus::Completed);
        // Planning errors fail the batch with the message; cancelling during planning cancels it.
        let mut p = batch(BatchKind::Upload);
        finish(&mut p, Err(AppError::invalid("Too many files")), false);
        assert_eq!((p.status, p.error.as_deref()), (BatchStatus::Failed, Some("Too many files")));
        let mut p = batch(BatchKind::Upload);
        finish(&mut p, Err(AppError::cancelled()), true);
        assert_eq!(p.status, BatchStatus::Cancelled);
        assert!(p.error.is_none());
    }

    #[test]
    fn errors_are_capped() {
        let mut b = batch(BatchKind::Download);
        for i in 0..(BATCH_MAX_ERRORS + 10) {
            push_failure(&mut b, format!("k{i}"), "m".into());
        }
        assert_eq!(b.failed_files as usize, BATCH_MAX_ERRORS + 10);
        assert_eq!(b.errors.len(), BATCH_MAX_ERRORS);
    }

    #[test]
    fn labels() {
        let r = |kind, prefix: &str, local: &str| BatchPlanRequest {
            kind,
            bucket: "b".into(),
            prefix: prefix.into(),
            local_path: local.into(),
            on_conflict: ConflictPolicy::Skip,
        };
        let local = std::env::temp_dir().join("photos").display().to_string();
        assert_eq!(label(&r(BatchKind::Upload, "", &local)), "Upload photos/");
        assert_eq!(label(&r(BatchKind::Download, "a/logs/", &local)), format!("Download logs/ to {local}"));
        assert_eq!(label(&r(BatchKind::Download, "a//", &local)), format!("Download a// to {local}"));
    }
}
