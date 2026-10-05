//! Parallel ranged download into a pre-sized `.part` file.
//!
//! Parts up to [`WHOLE_PART_MAX`] are collected in memory and written with one positional write
//! (as the parts of a transfer finish roughly in order, the file fills front to back). Larger
//! parts stream to their region of the file as they arrive, in batches of [`WRITE_BATCH`], into
//! a sparse file, so memory never grows with the part size: a transfer holds at most about
//! `parallel parts × min(part size, 16 MiB)`. A part whose connection fails after N bytes
//! resumes with `bytes=start+N-end` (still pinned by `If-Match`) instead of downloading those N
//! bytes again, so `transferredBytes` never goes backwards.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::Client;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use super::{cancellable, plan, set_sparse, write_all_at, PartSettings, TransferEntry, MIB};
use crate::error::{AppError, AppResult, ErrorCode};

/// Consecutive failed attempts (without receiving any new byte) after which a part gives up.
const PART_ATTEMPTS: u32 = 3;
/// A response body that delivers no bytes for this long is treated as a (retryable) network error.
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Parts up to this size are written with a single write once complete. Measured on NTFS with
/// a 9.5 GiB object: for the Auto part sizes this is ~20% faster than streaming, because parts
/// complete nearly in order and the file needs neither zero-filling nor sparse allocation.
const WHOLE_PART_MAX: u64 = 16 * MIB;
/// Larger parts are written in batches of this size (one write in flight per part while the
/// next batch fills), so such a part holds at most 2 batches in memory.
const WRITE_BATCH: usize = 1024 * 1024;

/// Temp file next to `dest`, unique per transfer (`{dest}.{first 8 of id}.part`), so two
/// downloads can never share one partially written file.
fn part_path(dest: &Path, id: &str) -> PathBuf {
    let mut s: OsString = dest.as_os_str().to_owned();
    s.push(format!(".{}.part", id.get(..8).unwrap_or(id)));
    PathBuf::from(s)
}

/// Creates the temp file, failing if it already exists (never truncate someone else's data).
fn create_tmp(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
}

/// Next body chunk, bounded by [`BODY_IDLE_TIMEOUT`] so a stalled connection cannot hang forever.
async fn next_chunk(body: &mut aws_sdk_s3::primitives::ByteStream) -> AppResult<Option<bytes::Bytes>> {
    match tokio::time::timeout(BODY_IDLE_TIMEOUT, body.try_next()).await {
        Ok(r) => Ok(r?),
        Err(_) => Err(AppError::new(
            ErrorCode::Network,
            format!("No data received for {} s", BODY_IDLE_TIMEOUT.as_secs()),
        )),
    }
}

/// The bytes `[start, start + len)` of the object, of which the first `done` are already written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    start: u64,
    len: u64,
    /// `true`: the whole object (`start == 0`, `len == size`), fetched with a plain GET while
    /// nothing has been received yet. A resumed attempt always uses a `Range`.
    whole: bool,
}

impl Span {
    /// The `Range` header for an attempt that starts after `done` bytes, if one is needed.
    fn range_header(&self, done: u64) -> Option<String> {
        (!self.whole || done > 0).then(|| format!("bytes={}-{}", self.start + done, self.start + self.len - 1))
    }

    /// Checks a response's `Content-Length` / `Content-Range` against what an attempt starting
    /// after `done` bytes asked for. Refusing anything else matters: a server that ignores `Range`
    /// would otherwise send the whole object for every part, and a concurrent overwrite must fail.
    fn check_response(&self, done: u64, content_length: Option<i64>, content_range: Option<&str>) -> AppResult<()> {
        let remaining = self.len - done;
        let Some(range) = self.range_header(done) else {
            if content_length.is_some_and(|n| n.max(0) as u64 != self.len) {
                return Err(changed());
            }
            return Ok(());
        };
        let (from, to) = (self.start + done, self.start + self.len - 1);
        let mismatch =
            |what: String| AppError::new(ErrorCode::Unknown, format!("Server did not honor the byte range {from}-{to}: {what}"));
        if let Some(n) = content_length {
            if n.max(0) as u64 != remaining {
                return Err(mismatch(format!("Content-Length {n}, expected {remaining} for {range}")));
            }
        }
        if let Some(cr) = content_range {
            if !cr.starts_with(&format!("bytes {from}-{to}/")) {
                return Err(mismatch(format!("Content-Range {cr}")));
            }
        }
        Ok(())
    }

    /// Error for a body that delivers more bytes than the attempt asked for.
    /// Bytes collected before each write: the whole span if it is small, else [`WRITE_BATCH`].
    fn write_batch(&self) -> usize {
        if self.len <= WHOLE_PART_MAX {
            self.len.max(1) as usize
        } else {
            WRITE_BATCH
        }
    }

    fn overrun(&self) -> AppError {
        if self.whole {
            changed()
        } else {
            AppError::new(
                ErrorCode::Unknown,
                format!("Server did not honor the byte range {}-{}: too many bytes", self.start, self.start + self.len - 1),
            )
        }
    }
}

fn changed() -> AppError {
    AppError::new(ErrorCode::Unknown, "The object changed during the download; try again")
}

/// Writes one part's bytes to its region of the shared file: bytes are collected into batches of
/// `batch` bytes, and each full batch is written by a blocking task while the next one fills (at
/// most one write in flight).
struct PartWriter {
    file: Arc<std::fs::File>,
    batch: usize,
    /// File offset of the next byte to be accepted (= part start + bytes accepted).
    next: u64,
    /// Accepted bytes not yet handed to a write; they end at `next`.
    buf: Vec<u8>,
    /// The write in flight; returns its buffer for reuse.
    pending: Option<JoinHandle<(std::io::Result<()>, Vec<u8>)>>,
    spare: Vec<u8>,
}

impl PartWriter {
    fn new(file: Arc<std::fs::File>, offset: u64, batch: usize) -> Self {
        Self { file, batch: batch.max(1), next: offset, buf: Vec::new(), pending: None, spare: Vec::new() }
    }

    async fn push(&mut self, chunk: &[u8]) -> AppResult<()> {
        // Never let a batch outgrow its reserved capacity (a doubling Vec would hold 2x).
        if !self.buf.is_empty() && self.buf.len() + chunk.len() > self.batch {
            self.submit().await?;
        }
        if self.buf.capacity() < self.batch {
            self.buf.reserve_exact(self.batch - self.buf.len());
        }
        self.buf.extend_from_slice(chunk);
        self.next += chunk.len() as u64;
        if self.buf.len() >= self.batch {
            self.submit().await?;
        }
        Ok(())
    }

    /// Waits for the write in flight, then starts writing the buffered bytes.
    async fn submit(&mut self) -> AppResult<()> {
        self.wait().await?;
        if self.buf.is_empty() {
            return Ok(());
        }
        let buf = std::mem::replace(&mut self.buf, std::mem::take(&mut self.spare));
        let offset = self.next - buf.len() as u64;
        let file = self.file.clone();
        self.pending = Some(tokio::task::spawn_blocking(move || (write_all_at(&file, &buf, offset), buf)));
        Ok(())
    }

    async fn wait(&mut self) -> AppResult<()> {
        if let Some(h) = self.pending.take() {
            let (r, mut buf) = h.await?;
            r?;
            buf.clear();
            self.spare = buf;
        }
        Ok(())
    }

    /// Writes every accepted byte and waits until the OS has it.
    async fn flush(&mut self) -> AppResult<()> {
        self.submit().await?;
        self.wait().await
    }
}

pub(super) async fn run(
    client: &Client,
    entry: &Arc<TransferEntry>,
    cfg: PartSettings,
    id: &str,
    bucket: &str,
    key: &str,
    dest: &Path,
) -> AppResult<()> {
    if dest.as_os_str().is_empty() {
        return Err(AppError::invalid("Destination path is required"));
    }
    // Child token: cancelled by the user (parent) or when a sibling part fails.
    let token = entry.cancel.child_token();

    let head = cancellable(&token, client.head_object().bucket(bucket).key(key).send()).await??;
    let size = head.content_length().unwrap_or(0).max(0) as u64;
    let etag = head.e_tag().map(str::to_string);

    if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = part_path(dest, id);
    let tmp_owned = tmp.clone();
    let file = tokio::task::spawn_blocking(move || create_tmp(&tmp_owned)).await??;

    let p = plan::plan_download(size, cfg.part_size_mib);
    entry.set_totals(size, p.parts_total());
    let result = if !p.multipart {
        let _in_flight = entry.part_started();
        let span = Span { start: 0, len: size, whole: true };
        fetch_part(client, entry, bucket, key, etag.as_deref(), Arc::new(file), span, &token).await
    } else {
        ranged(client, entry, bucket, key, etag, size, p.part_size, p.parts, cfg.max_parts, file, &token).await
    };

    match result {
        Ok(()) => {
            if let Err(e) = tokio::fs::rename(&tmp, dest).await {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e.into());
            }
            Ok(())
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn ranged(
    client: &Client,
    entry: &Arc<TransferEntry>,
    bucket: &str,
    key: &str,
    etag: Option<String>,
    size: u64,
    part_size: u64,
    parts: u64,
    max_parts: usize,
    file: std::fs::File,
    token: &CancellationToken,
) -> AppResult<()> {
    let file = tokio::task::spawn_blocking(move || -> std::io::Result<std::fs::File> {
        // Large parts stream far ahead of each other; see `set_sparse` (best effort). Small
        // parts fill the file nearly in order, where sparse allocation only costs time.
        if part_size > WHOLE_PART_MAX {
            let _ = set_sparse(&file);
        }
        file.set_len(size)?;
        Ok(file)
    })
    .await??;
    let file = Arc::new(file);
    let sem = Arc::new(Semaphore::new(max_parts.max(1)));
    let mut set: JoinSet<AppResult<()>> = JoinSet::new();
    let mut first_err: Option<AppError> = None;

    let note = |r: Result<AppResult<()>, tokio::task::JoinError>, first_err: &mut Option<AppError>| {
        let r = r.map_err(AppError::from).and_then(|x| x);
        if let Err(e) = r {
            token.cancel();
            if first_err.is_none() || first_err.as_ref().is_some_and(|f| f.is_cancelled() && !e.is_cancelled()) {
                *first_err = Some(e);
            }
        }
    };

    for i in 0..parts {
        while let Some(r) = set.try_join_next() {
            note(r, &mut first_err);
        }
        if first_err.is_some() || token.is_cancelled() {
            break;
        }
        let permit = match cancellable(token, sem.clone().acquire_owned()).await {
            Ok(Ok(p)) => p,
            _ => break,
        };
        let start = i * part_size;
        let span = Span { start, len: part_size.min(size - start), whole: false };
        let (client, entry, file, token) = (client.clone(), entry.clone(), file.clone(), token.clone());
        let (bucket, key, etag) = (bucket.to_string(), key.to_string(), etag.clone());
        set.spawn(async move {
            let _permit = permit;
            let _in_flight = entry.part_started();
            fetch_part(&client, &entry, &bucket, &key, etag.as_deref(), file, span, &token).await?;
            entry.part_done();
            Ok(())
        });
    }
    while let Some(r) = set.join_next().await {
        note(r, &mut first_err);
    }

    if let Some(e) = first_err {
        return Err(if entry.cancel.is_cancelled() { AppError::cancelled() } else { e });
    }
    if token.is_cancelled() {
        return Err(AppError::cancelled());
    }
    let f = file.clone();
    tokio::task::spawn_blocking(move || f.sync_all()).await??;
    Ok(())
}

/// Downloads `span` into `file` at its offsets. Retries transient (Network) failures; a retry
/// resumes after the last byte received, and only consecutive attempts that received nothing
/// count toward [`PART_ATTEMPTS`] (an attempt that made progress resets the count, so a flaky
/// but working link finishes; every such attempt moves the part forward, so this terminates).
/// Returns once every byte of the span has been handed to the OS.
#[allow(clippy::too_many_arguments)]
async fn fetch_part(
    client: &Client,
    entry: &TransferEntry,
    bucket: &str,
    key: &str,
    etag: Option<&str>,
    file: Arc<std::fs::File>,
    span: Span,
    token: &CancellationToken,
) -> AppResult<()> {
    let mut w = PartWriter::new(file, span.start, span.write_batch());
    let mut failures = 0;
    loop {
        let before = w.next;
        let e = match attempt(client, entry, bucket, key, etag, span, &mut w, token).await {
            Ok(()) => return w.flush().await,
            Err(e) => e,
        };
        if w.next > before {
            failures = 0;
        }
        failures += 1;
        if failures >= PART_ATTEMPTS || e.code != ErrorCode::Network {
            // Cancelled or fatal: the temp file is about to be deleted, so only let the write
            // in flight finish (never leave one running against it) instead of flushing.
            let _ = w.wait().await;
            return Err(e);
        }
        // Everything received is valid (pinned by If-Match and range-checked), so it is
        // written out and the retry starts after it.
        w.flush().await?;
        entry.note_retry(0);
        cancellable(token, tokio::time::sleep(Duration::from_millis(500 * u64::from(failures)))).await?;
    }
}

/// One GET for the rest of `span` (from `w.next`), streamed into `w`. Cancellation is checked
/// on every network wait; writes are never abandoned half-way.
#[allow(clippy::too_many_arguments)]
async fn attempt(
    client: &Client,
    entry: &TransferEntry,
    bucket: &str,
    key: &str,
    etag: Option<&str>,
    span: Span,
    w: &mut PartWriter,
    token: &CancellationToken,
) -> AppResult<()> {
    let done = w.next - span.start;
    let end = span.start + span.len;
    let resp = cancellable(
        token,
        client
            .get_object()
            .bucket(bucket)
            .key(key)
            .set_range(span.range_header(done))
            .set_if_match(etag.map(str::to_string))
            .send(),
    )
    .await??;
    span.check_response(done, resp.content_length(), resp.content_range())?;
    let mut body = resp.body;
    while let Some(chunk) = cancellable(token, next_chunk(&mut body)).await?? {
        if w.next + chunk.len() as u64 > end {
            return Err(span.overrun());
        }
        w.push(&chunk).await?;
        entry.add_bytes(chunk.len() as u64);
    }
    if w.next != end {
        return Err(AppError::new(
            ErrorCode::Network,
            format!(
                "Short read for bytes {}-{}: got {} of {} bytes",
                span.start,
                end.saturating_sub(1),
                w.next - span.start,
                span.len
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_is_unique_per_transfer() {
        let dest = Path::new("/tmp/report.pdf");
        let a = part_path(dest, "0123456789abcdef");
        let b = part_path(dest, "fedcba9876543210");
        assert_eq!(a, PathBuf::from("/tmp/report.pdf.01234567.part"));
        assert_ne!(a, b);
    }

    #[test]
    fn range_header_resumes_after_received_bytes() {
        let part = Span { start: 100, len: 50, whole: false };
        assert_eq!(part.range_header(0).as_deref(), Some("bytes=100-149"));
        assert_eq!(part.range_header(30).as_deref(), Some("bytes=130-149"));
        assert_eq!(part.range_header(49).as_deref(), Some("bytes=149-149"));
        // A whole-object GET has no Range until something was received; then it resumes.
        let whole = Span { start: 0, len: 1000, whole: true };
        assert_eq!(whole.range_header(0), None);
        assert_eq!(whole.range_header(400).as_deref(), Some("bytes=400-999"));
        assert_eq!(Span { start: 0, len: 0, whole: true }.range_header(0), None);
    }

    #[test]
    fn response_must_match_the_requested_range() {
        let part = Span { start: 100, len: 50, whole: false };
        assert!(part.check_response(0, Some(50), Some("bytes 100-149/1000")).is_ok());
        assert!(part.check_response(30, Some(20), Some("bytes 130-149/1000")).is_ok());
        assert!(part.check_response(30, Some(20), None).is_ok());
        // Server ignored Range (whole object) or answered the original range on a resume.
        assert!(part.check_response(0, Some(1000), None).is_err());
        assert!(part.check_response(30, Some(50), Some("bytes 100-149/1000")).is_err());
        assert!(part.check_response(30, Some(20), Some("bytes 100-119/1000")).is_err());
        let whole = Span { start: 0, len: 1000, whole: true };
        assert!(whole.check_response(0, Some(1000), None).is_ok());
        let e = whole.check_response(0, Some(1200), None).unwrap_err();
        assert_eq!(e.code, ErrorCode::Unknown);
        assert!(whole.check_response(400, Some(600), Some("bytes 400-999/1000")).is_ok());
        assert!(whole.check_response(400, Some(1000), None).is_err());
    }

    #[test]
    fn small_parts_are_written_whole_large_ones_in_batches() {
        assert_eq!(Span { start: 0, len: 8 * MIB, whole: false }.write_batch(), 8 * MIB as usize);
        assert_eq!(Span { start: 0, len: WHOLE_PART_MAX, whole: false }.write_batch(), WHOLE_PART_MAX as usize);
        assert_eq!(Span { start: 0, len: WHOLE_PART_MAX + 1, whole: false }.write_batch(), WRITE_BATCH);
        assert_eq!(Span { start: 0, len: 100 * MIB, whole: true }.write_batch(), WRITE_BATCH);
        assert_eq!(Span { start: 0, len: 0, whole: true }.write_batch(), 1);
    }

    #[tokio::test]
    async fn part_writer_places_bytes_at_their_offsets() {
        let path = std::env::temp_dir().join(format!("s3x-pw-{}.bin", uuid::Uuid::new_v4()));
        let file = Arc::new(create_tmp(&path).unwrap());
        file.set_len(4 * WRITE_BATCH as u64).unwrap();
        let data: Vec<u8> = (0..3 * WRITE_BATCH + 12_345).map(|i| (i * 7 % 251) as u8).collect();
        // Second region, in uneven chunks, flushed half-way (as after a failed attempt).
        let mut w = PartWriter::new(file.clone(), 1000, WRITE_BATCH);
        let (a, b) = data.split_at(WRITE_BATCH + 777);
        for c in a.chunks(70_001) {
            w.push(c).await.unwrap();
        }
        w.flush().await.unwrap();
        assert_eq!(w.next, 1000 + a.len() as u64);
        for c in b.chunks(65_536) {
            w.push(c).await.unwrap();
        }
        w.flush().await.unwrap();
        assert!(w.pending.is_none() && w.buf.is_empty());
        assert!(w.spare.capacity() <= WRITE_BATCH + 70_001, "batch buffers stay bounded");
        drop((w, file));
        let got = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(got[..1000].iter().all(|b| *b == 0));
        assert_eq!(&got[1000..1000 + data.len()], &data[..]);
        assert!(got[1000 + data.len()..].iter().all(|b| *b == 0));
    }
}
