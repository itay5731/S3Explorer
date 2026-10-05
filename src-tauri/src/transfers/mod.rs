//! Background transfer manager (parallel ranged downloads, multipart uploads).

mod download;
mod upload;

use std::collections::VecDeque;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use aws_sdk_s3::Client;
use dashmap::DashMap;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::models::{now_iso, Transfer, TransferKind, TransferStatus};

/// At most this many transfers run at once; the rest stay `queued`.
pub const MAX_RUNNING_TRANSFERS: usize = 4;
/// Concurrent parts within one transfer.
pub const MAX_PARTS_IN_FLIGHT: usize = 8;
pub const MIB: u64 = 1024 * 1024;
/// Objects larger than this use ranged / multipart transfers.
pub const MULTIPART_THRESHOLD: u64 = 8 * MIB;
const TICK: Duration = Duration::from_millis(100);
const RATE_WINDOW: Duration = Duration::from_secs(2);

/// Receives `Transfer` snapshots (the Tauri app emits them as `transfer:progress`).
pub trait ProgressSink: Send + Sync + 'static {
    fn emit(&self, transfer: &Transfer);
}

/// A sink that drops every event.
pub struct NoopSink;
impl ProgressSink for NoopSink {
    fn emit(&self, _transfer: &Transfer) {}
}

/// Any closure can be a sink (handy for tests).
impl<F: Fn(&Transfer) + Send + Sync + 'static> ProgressSink for F {
    fn emit(&self, transfer: &Transfer) {
        self(transfer)
    }
}

pub struct TransferEntry {
    seq: u64,
    record: Mutex<Transfer>,
    cancel: CancellationToken,
    finished: CancellationToken,
    transferred: AtomicU64,
    parts_done: AtomicU32,
}

impl TransferEntry {
    fn lock(&self) -> MutexGuard<'_, Transfer> {
        // A poisoned lock only means another thread panicked mid-update; the data is still usable.
        self.record.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set_totals(&self, total_bytes: u64, parts_total: u32) {
        let mut r = self.lock();
        r.total_bytes = total_bytes;
        r.parts_total = parts_total;
    }

    fn add_bytes(&self, n: u64) {
        self.transferred.fetch_add(n, Ordering::Relaxed);
    }

    fn sub_bytes(&self, n: u64) {
        // Saturating subtract (used when a part is retried).
        let _ = self.transferred.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v.saturating_sub(n)));
    }

    fn part_done(&self) {
        self.parts_done.fetch_add(1, Ordering::Relaxed);
    }

    /// Copies counters into the record and returns a clone of it.
    fn snapshot(&self) -> Transfer {
        let mut r = self.lock();
        r.transferred_bytes = self.transferred.load(Ordering::Relaxed);
        r.parts_done = self.parts_done.load(Ordering::Relaxed);
        r.clone()
    }

    fn status(&self) -> TransferStatus {
        self.lock().status
    }
}

enum Job {
    Download { dest: PathBuf },
    Upload { src: PathBuf },
}

pub struct TransferManager {
    entries: DashMap<String, Arc<TransferEntry>>,
    running: Arc<Semaphore>,
    sink: Arc<dyn ProgressSink>,
    seq: AtomicU64,
    /// Serializes the "is this destination already being downloaded?" check with the insert.
    start_lock: Mutex<()>,
}

/// Download destinations must be absolute and free of `..` so a crafted key can never
/// steer a write outside the folder the user picked.
fn validate_download_dest(dest: &Path) -> AppResult<()> {
    if dest.as_os_str().is_empty() {
        return Err(AppError::invalid("Destination path is required"));
    }
    if !dest.is_absolute() {
        return Err(AppError::invalid(format!("Destination must be an absolute path: {}", dest.display())));
    }
    if dest.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid(format!("Destination must not contain \"..\": {}", dest.display())));
    }
    Ok(())
}

/// Comparison key for "same local file" (case-insensitive and separator-agnostic on Windows).
fn dest_key(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.to_string()
    }
}

impl TransferManager {
    pub fn new(sink: Arc<dyn ProgressSink>) -> Arc<Self> {
        Arc::new(Self {
            entries: DashMap::new(),
            running: Arc::new(Semaphore::new(MAX_RUNNING_TRANSFERS)),
            sink,
            seq: AtomicU64::new(0),
            start_lock: Mutex::new(()),
        })
    }

    /// Queues a download of `bucket/key` to `dest`. Must be called within a Tokio runtime.
    ///
    /// Rejects (`InvalidInput`) a relative destination, one containing `..`, and one that an
    /// active (queued/running) download already targets.
    pub fn start_download(self: &Arc<Self>, client: Client, bucket: &str, key: &str, dest: PathBuf) -> AppResult<String> {
        validate_download_dest(&dest)?;
        let local = dest.to_string_lossy().into_owned();
        let _guard = self.start_lock.lock().unwrap_or_else(|p| p.into_inner());
        let wanted = dest_key(&local);
        let busy = self.entries.iter().any(|e| {
            let r = e.lock();
            r.kind == TransferKind::Download && r.status.is_active() && dest_key(&r.local_path) == wanted
        });
        if busy {
            return Err(AppError::invalid(format!(
                "Another download is already writing to {local}. Wait for it to finish or cancel it first."
            )));
        }
        Ok(self.start(client, TransferKind::Download, bucket, key, local, Job::Download { dest }))
    }

    /// Queues an upload of `src` to `bucket/key`. Must be called within a Tokio runtime.
    pub fn start_upload(self: &Arc<Self>, client: Client, bucket: &str, key: &str, src: PathBuf) -> String {
        let local = src.to_string_lossy().into_owned();
        self.start(client, TransferKind::Upload, bucket, key, local, Job::Upload { src })
    }

    fn start(
        self: &Arc<Self>,
        client: Client,
        kind: TransferKind,
        bucket: &str,
        key: &str,
        local_path: String,
        job: Job,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let record = Transfer {
            id: id.clone(),
            kind,
            bucket: bucket.to_string(),
            key: key.to_string(),
            local_path,
            total_bytes: 0,
            transferred_bytes: 0,
            parts_total: 0,
            parts_done: 0,
            bytes_per_sec: 0,
            status: TransferStatus::Queued,
            error: None,
            started_at: now_iso(),
            finished_at: None,
        };
        let entry = Arc::new(TransferEntry {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            record: Mutex::new(record),
            cancel: CancellationToken::new(),
            finished: CancellationToken::new(),
            transferred: AtomicU64::new(0),
            parts_done: AtomicU32::new(0),
        });
        self.entries.insert(id.clone(), entry.clone());
        self.sink.emit(&entry.snapshot());
        let me = self.clone();
        tokio::spawn(async move { me.run_job(entry, client, job).await });
        id
    }

    async fn run_job(self: Arc<Self>, entry: Arc<TransferEntry>, client: Client, job: Job) {
        let permit = tokio::select! {
            biased;
            _ = entry.cancel.cancelled() => None,
            p = self.running.clone().acquire_owned() => p.ok(),
        };

        let result = match permit {
            None => Err(AppError::cancelled()),
            Some(_permit) => {
                entry.lock().status = TransferStatus::Running;
                self.sink.emit(&entry.snapshot());

                let stop = CancellationToken::new();
                let ticker = tokio::spawn(ticker(self.sink.clone(), entry.clone(), stop.clone()));
                let (id, bucket, key) = {
                    let r = entry.lock();
                    (r.id.clone(), r.bucket.clone(), r.key.clone())
                };
                let r = match job {
                    Job::Download { dest } => download::run(&client, &entry, &id, &bucket, &key, &dest).await,
                    Job::Upload { src } => upload::run(&client, &entry, &bucket, &key, &src).await,
                };
                stop.cancel();
                let _ = ticker.await;
                r
            }
        };

        {
            let mut rec = entry.lock();
            rec.bytes_per_sec = 0;
            rec.finished_at = Some(now_iso());
            match result {
                Ok(()) => {
                    rec.status = TransferStatus::Completed;
                    entry.transferred.store(rec.total_bytes, Ordering::Relaxed);
                    entry.parts_done.store(rec.parts_total, Ordering::Relaxed);
                }
                Err(e) if e.is_cancelled() || entry.cancel.is_cancelled() => {
                    rec.status = TransferStatus::Cancelled;
                }
                Err(e) => {
                    rec.status = TransferStatus::Failed;
                    rec.error = Some(e.message);
                }
            }
        }
        self.sink.emit(&entry.snapshot());
        entry.finished.cancel();
    }

    /// Cooperative cancel. No-op for transfers that already finished.
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let entry = self.entries.get(id).map(|e| e.clone()).ok_or_else(|| AppError::invalid("Unknown transfer id"))?;
        entry.cancel.cancel();
        Ok(())
    }

    /// Forgets a finished transfer. Active transfers must be cancelled first.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let Some(entry) = self.entries.get(id).map(|e| e.clone()) else {
            return Ok(());
        };
        if entry.status().is_active() {
            return Err(AppError::invalid("Transfer is still active; cancel it first"));
        }
        self.entries.remove(id);
        Ok(())
    }

    /// All known transfers, oldest first.
    pub fn list(&self) -> Vec<Transfer> {
        let mut v: Vec<(u64, Transfer)> = self.entries.iter().map(|e| (e.seq, e.snapshot())).collect();
        v.sort_by_key(|(s, _)| *s);
        v.into_iter().map(|(_, t)| t).collect()
    }

    pub fn get(&self, id: &str) -> Option<Transfer> {
        self.entries.get(id).map(|e| e.snapshot())
    }

    /// Waits until the transfer reaches a final state and returns it.
    pub async fn wait(&self, id: &str) -> Option<Transfer> {
        let entry = self.entries.get(id).map(|e| e.clone())?;
        entry.finished.cancelled().await;
        Some(entry.snapshot())
    }
}

/// Emits progress at most every 100 ms while a transfer runs, with a ~2 s rolling rate.
async fn ticker(sink: Arc<dyn ProgressSink>, entry: Arc<TransferEntry>, stop: CancellationToken) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut samples: VecDeque<(Instant, u64)> = VecDeque::new();
    let mut last: Option<(u64, u32, u64)> = None;
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            _ = interval.tick() => {}
        }
        let now = Instant::now();
        let bytes = entry.transferred.load(Ordering::Relaxed);
        samples.push_back((now, bytes));
        while samples.len() > 2 && samples.front().is_some_and(|(t, _)| now.duration_since(*t) > RATE_WINDOW) {
            samples.pop_front();
        }
        let bps = match samples.front() {
            Some((t0, b0)) => {
                let dt = now.duration_since(*t0).as_secs_f64();
                if dt > 0.05 {
                    (bytes.saturating_sub(*b0) as f64 / dt) as u64
                } else {
                    0
                }
            }
            None => 0,
        };
        entry.lock().bytes_per_sec = bps;
        let snap = entry.snapshot();
        let key = (snap.transferred_bytes, snap.parts_done, snap.bytes_per_sec);
        if last != Some(key) {
            last = Some(key);
            sink.emit(&snap);
        }
    }
}

/// Runs `f` unless `token` is cancelled first.
async fn cancellable<T>(token: &CancellationToken, f: impl Future<Output = T>) -> AppResult<T> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(AppError::cancelled()),
        v = f => Ok(v),
    }
}

/// Number of `part_size` parts needed for `size` bytes.
fn part_count(size: u64, part_size: u64) -> u64 {
    size.div_ceil(part_size).max(1)
}

/// Positional write of the whole buffer (thread-safe on a shared handle).
fn write_all_at(file: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_all_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let (mut buf, mut offset) = (buf, offset);
        while !buf.is_empty() {
            let n = file.seek_write(buf, offset)?;
            if n == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "failed to write part"));
            }
            buf = &buf[n..];
            offset += n as u64;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_dest_validation() {
        let abs = std::env::temp_dir().join("x.bin");
        assert!(validate_download_dest(&abs).is_ok());
        assert!(validate_download_dest(Path::new("")).is_err());
        assert!(validate_download_dest(Path::new("relative/x.bin")).is_err());
        assert!(validate_download_dest(&std::env::temp_dir().join("..").join("x.bin")).is_err());
        assert!(validate_download_dest(&std::env::temp_dir().join("a").join("..").join("..").join("x")).is_err());
    }

    #[test]
    fn dest_key_matches_same_file() {
        assert_eq!(dest_key("/a/b"), dest_key("/a/b"));
        if cfg!(windows) {
            assert_eq!(dest_key(r"C:\Dl\Report.pdf"), dest_key("c:/dl/report.PDF"));
        }
    }
}
