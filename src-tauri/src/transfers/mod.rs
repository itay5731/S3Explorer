//! Background transfer manager (parallel ranged downloads, multipart uploads).

mod download;
pub(crate) mod gate;
pub mod plan;
mod upload;

use std::collections::VecDeque;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use aws_sdk_s3::Client;
use dashmap::DashMap;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::models::{now_iso, Transfer, TransferKind, TransferSettings, TransferStatus};
use gate::RunGate;

pub const MIB: u64 = 1024 * 1024;
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
    /// Parts currently in flight, and the high-water mark (observability for tests).
    parts_in_flight: AtomicUsize,
    peak_parts_in_flight: AtomicUsize,
    /// Part attempts that failed and were retried, and the bytes those attempts had received
    /// but that had to be fetched again (observability for tests and benchmarks).
    part_retries: AtomicU32,
    discarded_bytes: AtomicU64,
}

/// Internal counters of one transfer, for tests and benchmarks (not part of the bridge contract).
#[derive(Debug, Clone, Copy, Default)]
pub struct TransferStats {
    pub peak_parts_in_flight: usize,
    pub part_retries: u32,
    pub discarded_bytes: u64,
}

/// Counts a part as in flight for its lifetime (see [`TransferEntry::part_started`]).
pub(crate) struct InFlight<'a>(&'a TransferEntry);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.parts_in_flight.fetch_sub(1, Ordering::Relaxed);
    }
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

    fn note_retry(&self, discarded: u64) {
        self.part_retries.fetch_add(1, Ordering::Relaxed);
        self.discarded_bytes.fetch_add(discarded, Ordering::Relaxed);
    }

    fn part_done(&self) {
        self.parts_done.fetch_add(1, Ordering::Relaxed);
    }

    fn part_started(&self) -> InFlight<'_> {
        let now = self.parts_in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak_parts_in_flight.fetch_max(now, Ordering::Relaxed);
        InFlight(self)
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

/// The settings a transfer snapshots when it starts running.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PartSettings {
    pub part_size_mib: Option<u32>,
    pub max_parts: usize,
}

impl From<&TransferSettings> for PartSettings {
    fn from(s: &TransferSettings) -> Self {
        Self { part_size_mib: s.part_size_mib, max_parts: (s.max_concurrent_parts as usize).max(1) }
    }
}

pub struct TransferManager {
    entries: DashMap<String, Arc<TransferEntry>>,
    /// Limits running transfers to `maxConcurrentTransfers`; resizable at runtime (see `gate`).
    running: Arc<RunGate>,
    settings: Mutex<TransferSettings>,
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
    /// A manager with default settings.
    pub fn new(sink: Arc<dyn ProgressSink>) -> Arc<Self> {
        Self::with_settings(sink, TransferSettings::default())
    }

    pub fn with_settings(sink: Arc<dyn ProgressSink>, settings: TransferSettings) -> Arc<Self> {
        Arc::new(Self {
            entries: DashMap::new(),
            running: RunGate::new(settings.max_concurrent_transfers as usize),
            settings: Mutex::new(settings),
            sink,
            seq: AtomicU64::new(0),
            start_lock: Mutex::new(()),
        })
    }

    /// The settings new transfers will snapshot.
    pub fn settings(&self) -> TransferSettings {
        *self.settings.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Applies new settings. Part size / parts in flight affect transfers that start running
    /// from now on; the transfer limit applies to the queue immediately. Callers validate first.
    pub fn apply_settings(&self, settings: &TransferSettings) {
        *self.settings.lock().unwrap_or_else(|p| p.into_inner()) = *settings;
        self.running.set_limit(settings.max_concurrent_transfers as usize);
    }

    /// Transfers holding a run slot right now.
    pub fn running_count(&self) -> usize {
        self.running.running()
    }

    /// Highest number of parts this transfer ever had in flight at once.
    pub fn peak_parts_in_flight(&self, id: &str) -> Option<usize> {
        self.entries.get(id).map(|e| e.peak_parts_in_flight.load(Ordering::Relaxed))
    }

    /// Internal counters of a transfer (peak parts in flight, part retries, discarded bytes).
    pub fn stats(&self, id: &str) -> Option<TransferStats> {
        self.entries.get(id).map(|e| TransferStats {
            peak_parts_in_flight: e.peak_parts_in_flight.load(Ordering::Relaxed),
            part_retries: e.part_retries.load(Ordering::Relaxed),
            discarded_bytes: e.discarded_bytes.load(Ordering::Relaxed),
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
            parts_in_flight: AtomicUsize::new(0),
            peak_parts_in_flight: AtomicUsize::new(0),
            part_retries: AtomicU32::new(0),
            discarded_bytes: AtomicU64::new(0),
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
            p = self.running.acquire() => Some(p),
        };

        let result = match &permit {
            None => Err(AppError::cancelled()),
            Some(_) => {
                // Snapshot now (not at queue time): settings changed while queued still apply.
                let cfg = PartSettings::from(&self.settings());
                entry.lock().status = TransferStatus::Running;
                self.sink.emit(&entry.snapshot());

                let stop = CancellationToken::new();
                let ticker = tokio::spawn(ticker(self.sink.clone(), entry.clone(), stop.clone()));
                let (id, bucket, key) = {
                    let r = entry.lock();
                    (r.id.clone(), r.bucket.clone(), r.key.clone())
                };
                let r = match job {
                    Job::Download { dest } => download::run(&client, &entry, cfg, &id, &bucket, &key, &dest).await,
                    Job::Upload { src } => upload::run(&client, &entry, cfg, &bucket, &key, &src).await,
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
        // Release the run slot only after the final event, so observers never see the next
        // queued transfer running while this one still looks running.
        drop(permit);
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

/// Marks a file sparse (Windows; best effort, callers ignore errors).
///
/// Parts that stream to disk as they arrive write far ahead of the file's valid data length. On
/// a normal NTFS file each such write first makes the OS zero-fill the gap, so nearly every byte
/// hits the disk twice (zeros, then data): measured ~1.6x disk writes and ~25% lower throughput
/// on a 9.5 GiB download. The unwritten ranges of a sparse file need no zeroing. Filesystems without sparse support
/// (FAT32, exFAT) return an error and the download proceeds as before. Elsewhere `set_len`
/// already creates sparse files, so this is a no-op.
#[cfg(windows)]
fn set_sparse(file: &std::fs::File) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::{null, null_mut};
    const FSCTL_SET_SPARSE: u32 = 0x0009_00C4;
    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            device: *mut c_void,
            code: u32,
            in_buf: *const c_void,
            in_size: u32,
            out_buf: *mut c_void,
            out_size: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
    }
    let mut returned = 0u32;
    // SAFETY: `file` keeps the handle open for the duration of this synchronous call; no input
    // or output buffers are passed (a null input buffer means "set sparse").
    let ok = unsafe {
        DeviceIoControl(file.as_raw_handle(), FSCTL_SET_SPARSE, null(), 0, null_mut(), 0, &mut returned, null_mut())
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn set_sparse(_file: &std::fs::File) -> std::io::Result<()> {
    Ok(())
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
    fn sparse_file_reads_back_zeros_and_data() {
        let path = std::env::temp_dir().join(format!("s3x-sparse-{}.bin", uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        let sparse = set_sparse(&file);
        if cfg!(windows) {
            // The temp dir is NTFS on Windows dev machines and CI runners.
            assert!(sparse.is_ok(), "{sparse:?}");
        }
        file.set_len(3 * MIB).unwrap();
        write_all_at(&file, b"tail", 3 * MIB - 4).unwrap();
        write_all_at(&file, b"head", 0).unwrap();
        drop(file);
        let got = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(got.len() as u64, 3 * MIB);
        assert_eq!(&got[..4], b"head");
        assert_eq!(&got[got.len() - 4..], b"tail");
        assert!(got[4..got.len() - 4].iter().all(|b| *b == 0));
    }

    #[test]
    fn dest_key_matches_same_file() {
        assert_eq!(dest_key("/a/b"), dest_key("/a/b"));
        if cfg!(windows) {
            assert_eq!(dest_key(r"C:\Dl\Report.pdf"), dest_key("c:/dl/report.PDF"));
        }
    }
}
