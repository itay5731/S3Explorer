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

/// Consecutive failed attempts without meaningful progress after which a part gives up.
const PART_ATTEMPTS: u32 = 3;
/// A failed attempt counts as progress only if it delivered at least this much (or the whole
/// rest of the part, if that is smaller): a peer that sends a few bytes per connection and then
/// resets must not be retried practically forever.
const MIN_PROGRESS: u64 = 64 * 1024;
/// Every part also has a total attempt budget: `3 + ceil(part length / 1 MiB)`, at most this.
const MAX_PART_ATTEMPTS: u64 = 1_000;
/// A response body that delivers no bytes for this long is treated as a (retryable) network error.
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Parts up to this size are written with a single write once complete. Measured on NTFS with
/// a 9.5 GiB object: for the Auto part sizes this is ~20% faster than streaming, because parts
/// complete nearly in order and the file needs neither zero-filling nor sparse allocation.
const WHOLE_PART_MAX: u64 = 16 * MIB;
/// Larger parts are written in batches of this size (one write in flight per part while the
/// next batch fills), so such a part holds at most 2 batches in memory.
const WRITE_BATCH: usize = 1024 * 1024;

/// The object a download reads: the current version, or `version_id` (sent on HeadObject and
/// on every GET).
#[derive(Debug, Clone, Copy)]
pub(super) struct Source<'a> {
    pub bucket: &'a str,
    pub key: &'a str,
    pub version_id: Option<&'a str>,
}

/// Temp file next to `dest`, unique per transfer (`{dest}.{first 8 of id}.part`), so two
/// downloads can never share one partially written file.
fn part_path(dest: &Path, id: &str) -> PathBuf {
    let suffix = format!(".{}.part", id.get(..8).unwrap_or(id));
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // File names are limited to 255 units (UTF-16 on Windows, bytes elsewhere): a long name plus
    // the suffix would not fit, so the temp file then uses a shortened name (UTF-8 bytes are an
    // upper bound for both). The final name is unchanged.
    if name.len() + suffix.len() > MAX_NAME_BYTES {
        let mut cut = MAX_NAME_BYTES - suffix.len();
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        return dest.with_file_name(format!("{}{suffix}", &name[..cut]));
    }
    let mut s: OsString = dest.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// The longest file name most file systems accept.
const MAX_NAME_BYTES: usize = 255;

/// `InvalidInput` when a symbolic link or junction lies between `root` and `dest` (or is `dest`).
pub(crate) fn refuse_links(root: &Path, dest: &Path) -> AppResult<()> {
    let mut cache = std::collections::HashMap::new();
    match crate::batches::localname::link_below(root, dest, &mut cache) {
        Some(link) => Err(AppError::invalid(crate::batches::localname::link_message(&link))),
        None => Ok(()),
    }
}

/// `InvalidInput` unless the canonical `dir` is inside the canonical `root`.
pub(crate) fn require_inside(root: &Path, dir: &Path) -> AppResult<()> {
    let real_root = std::fs::canonicalize(root)?;
    let real_dir = std::fs::canonicalize(dir)?;
    if real_dir.starts_with(&real_root) {
        Ok(())
    } else {
        Err(AppError::invalid(format!(
            "Not downloaded: {} leads outside {} (a link to another location)",
            dir.display(),
            root.display()
        )))
    }
}

/// Creates the temp file, failing if it already exists (never truncate someone else's data).
fn create_tmp(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
}

/// True if `e` or any error it wraps is a response checksum mismatch (the data is corrupt).
fn is_checksum_mismatch(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur = Some(e);
    while let Some(err) = cur {
        if err.downcast_ref::<aws_smithy_checksums::body::validate::Error>().is_some() {
            return true;
        }
        cur = err.source();
    }
    false
}

/// Next body chunk, bounded by [`BODY_IDLE_TIMEOUT`] so a stalled connection cannot hang forever.
/// Transport errors are `Network` (retryable); a checksum mismatch is not (`Unknown`): retrying
/// or keeping what was received would accept corrupt data.
async fn next_chunk(body: &mut aws_sdk_s3::primitives::ByteStream) -> AppResult<Option<bytes::Bytes>> {
    match tokio::time::timeout(BODY_IDLE_TIMEOUT, body.try_next()).await {
        Ok(Ok(c)) => Ok(c),
        Ok(Err(e)) if is_checksum_mismatch(&e) => Err(AppError::new(
            ErrorCode::Unknown,
            format!("The downloaded data failed checksum validation: {}", aws_sdk_s3::error::DisplayErrorContext(&e)),
        )),
        Ok(Err(e)) => Err(e.into()),
        Err(_) => Err(AppError::new(
            ErrorCode::Network,
            format!("No data received for {} s", BODY_IDLE_TIMEOUT.as_secs()),
        )),
    }
}

/// What a part does after a failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryDecision {
    /// Retry (resuming after the bytes received so far) after this pause.
    Retry(Duration),
    GiveUp,
}

/// Retry budget of one part: at most [`PART_ATTEMPTS`] consecutive failed attempts without
/// meaningful progress (see [`MIN_PROGRESS`]), and at most `3 + ceil(len / 1 MiB)` attempts in
/// total (capped at [`MAX_PART_ATTEMPTS`]), so every part terminates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryPolicy {
    max_attempts: u64,
    attempts: u64,
    failures: u32,
}

impl RetryPolicy {
    fn new(part_len: u64) -> Self {
        Self { max_attempts: (3 + part_len.div_ceil(MIB)).min(MAX_PART_ATTEMPTS), attempts: 0, failures: 0 }
    }

    /// After a failed (retryable) attempt that started with `remaining` bytes of the part still
    /// missing and received `got` of them.
    fn after_failure(&mut self, remaining: u64, got: u64) -> RetryDecision {
        self.attempts += 1;
        if got > 0 && got >= MIN_PROGRESS.min(remaining) {
            self.failures = 0;
        }
        self.failures += 1;
        if self.failures >= PART_ATTEMPTS || self.attempts >= self.max_attempts {
            RetryDecision::GiveUp
        } else {
            RetryDecision::Retry(Duration::from_millis(500 * u64::from(self.failures)))
        }
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
    /// The `Range` header for an attempt that starts after `done` bytes, if one is needed. Never
    /// an empty or inverted range: callers never start an attempt once every byte is received
    /// (`done >= len`), and for that case this returns `None` rather than `start > end`.
    fn range_header(&self, done: u64) -> Option<String> {
        if done >= self.len {
            return None;
        }
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

/// The error of a `no_replace` download whose destination exists.
fn exists_error(dest: &Path) -> AppError {
    AppError::new(
        crate::error::ErrorCode::Conflict,
        format!("A file already exists at {}; it was left unchanged", dest.display()),
    )
}

/// Renames `from` to `to` but never replaces an existing `to` (`AlreadyExists` instead).
/// Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` (atomic). Elsewhere: a hard link
/// (fails atomically if `to` exists) and removing `from`; on a filesystem without hard links,
/// an existence check and a plain rename.
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        let wide = |p: &Path| -> Vec<u16> { verbatim(p).encode_wide().chain(std::iter::once(0)).collect() };
        let (a, b) = (wide(from), wide(to));
        // SAFETY: both buffers are NUL-terminated UTF-16 strings that outlive this synchronous call.
        let ok = unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0) };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        match std::fs::hard_link(from, to) {
            Ok(()) => std::fs::remove_file(from),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(e),
            Err(_) => {
                if std::fs::symlink_metadata(to).is_ok() {
                    return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "destination exists"));
                }
                std::fs::rename(from, to)
            }
        }
    }
}

/// `C:\a\b` as `\\?\C:\a\b` (and `\\server\share\x` as `\\?\UNC\server\share\x`), so the raw
/// Win32 call accepts paths longer than 260 characters (`std::fs` does this by itself). Paths it
/// cannot convert safely (relative, with `..`, already verbatim, device paths) are returned as is.
#[cfg(windows)]
fn verbatim(p: &Path) -> OsString {
    use std::path::{Component, Prefix};
    let mut comps = p.components();
    let mut s = OsString::new();
    match comps.next() {
        Some(Component::Prefix(pre)) => match pre.kind() {
            Prefix::Disk(_) => {
                s.push(r"\\?\");
                s.push(pre.as_os_str());
            }
            Prefix::UNC(server, share) => {
                s.push(r"\\?\UNC\");
                s.push(server);
                s.push(r"\");
                s.push(share);
            }
            _ => return p.as_os_str().to_owned(),
        },
        _ => return p.as_os_str().to_owned(),
    }
    for c in comps {
        match c {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(n) => {
                s.push(r"\");
                s.push(n);
            }
            Component::ParentDir | Component::Prefix(_) => return p.as_os_str().to_owned(),
        }
    }
    s
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    client: &Client,
    entry: &Arc<TransferEntry>,
    cfg: PartSettings,
    id: &str,
    src: Source<'_>,
    dest: &Path,
    no_replace: bool,
    within: Option<&Path>,
) -> AppResult<()> {
    if dest.as_os_str().is_empty() {
        return Err(AppError::invalid("Destination path is required"));
    }
    // A folder download's file must stay inside its root: a link created after planning on the
    // way (or at the file itself) fails the file before anything is created or requested.
    if let Some(root) = within {
        let (r, d) = (root.to_path_buf(), dest.to_path_buf());
        tokio::task::spawn_blocking(move || refuse_links(&r, &d)).await??;
    }
    // Checked before any request (no bandwidth spent on a file that will be refused) and again,
    // atomically, at the final rename (something may appear at `dest` meanwhile).
    if no_replace && tokio::fs::symlink_metadata(dest).await.is_ok() {
        return Err(exists_error(dest));
    }
    // Child token: cancelled by the user (parent) or when a sibling part fails.
    let token = entry.cancel.child_token();

    let head = client.head_object().bucket(src.bucket).key(src.key).set_version_id(src.version_id.map(str::to_string));
    let head = match cancellable(&token, head.send()).await? {
        Ok(h) => h,
        Err(e) => {
            let e = AppError::from(e);
            return Err(match src.version_id {
                // HeadObject has no body, so S3 cannot say "NoSuchVersion" here.
                Some(v) if e.code == ErrorCode::NoSuchKey => crate::versions::no_such_version(src.key, v),
                _ => e,
            });
        }
    };
    let size = head.content_length().unwrap_or(0).max(0) as u64;
    let etag = head.e_tag().map(str::to_string);

    if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent).await?;
        // And once the folders exist: the real (canonical) folder must be inside the real root.
        if let Some(root) = within {
            let (r, p) = (root.to_path_buf(), parent.to_path_buf());
            tokio::task::spawn_blocking(move || require_inside(&r, &p)).await??;
        }
    }
    let tmp = part_path(dest, id);
    let tmp_owned = tmp.clone();
    let file = Arc::new(tokio::task::spawn_blocking(move || create_tmp(&tmp_owned)).await??);
    // Removes the temp file if this future is dropped or panics before it is renamed.
    let mut tmp_guard = RemoveOnDrop(Some(tmp.clone()));

    let p = plan::plan_download(size, cfg.part_size_mib);
    entry.set_totals(size, p.parts_total());
    let result = if !p.multipart {
        let _in_flight = entry.part_started();
        let span = Span { start: 0, len: size, whole: true };
        fetch_part(client, entry, src, etag.as_deref(), file.clone(), span, &token).await
    } else {
        ranged(client, entry, src, etag, size, p.part_size, p.parts, cfg.max_parts, file.clone(), &token).await
    };
    // Both paths: every byte reaches the disk before the file gets its final name, so a crash
    // right after "completed" never leaves a short or zero-filled file under that name.
    let result = match result {
        Ok(()) => {
            let f = file.clone();
            match tokio::task::spawn_blocking(move || f.sync_all()).await {
                Ok(Ok(())) => {
                    entry.file_syncs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    Ok(())
                }
                Ok(Err(e)) => Err(e.into()),
                Err(e) => Err(e.into()),
            }
        }
        Err(e) => Err(e),
    };
    drop(file);

    match result {
        Ok(()) => {
            let renamed = if no_replace {
                let (from, to) = (tmp.clone(), dest.to_path_buf());
                match tokio::task::spawn_blocking(move || rename_no_replace(&from, &to)).await {
                    Ok(Err(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(exists_error(dest)),
                    Ok(r) => r.map_err(AppError::from),
                    Err(e) => Err(AppError::from(e)),
                }
            } else {
                tokio::fs::rename(&tmp, dest).await.map_err(AppError::from)
            };
            if let Err(e) = renamed {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e);
            }
            tmp_guard.0 = None;
            Ok(())
        }
        Err(e) => {
            if tokio::fs::remove_file(&tmp).await.is_ok() {
                tmp_guard.0 = None;
            }
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn ranged(
    client: &Client,
    entry: &Arc<TransferEntry>,
    src: Source<'_>,
    etag: Option<String>,
    size: u64,
    part_size: u64,
    parts: u64,
    max_parts: usize,
    file: Arc<std::fs::File>,
    token: &CancellationToken,
) -> AppResult<()> {
    let f = file.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        // Large parts stream far ahead of each other; see `set_sparse` (best effort). Small
        // parts fill the file nearly in order, where sparse allocation only costs time.
        if part_size > WHOLE_PART_MAX {
            let _ = set_sparse(&f);
        }
        f.set_len(size)
    })
    .await??;
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
        let (bucket, key, etag) = (src.bucket.to_string(), src.key.to_string(), etag.clone());
        let version_id = src.version_id.map(str::to_string);
        set.spawn(async move {
            let _permit = permit;
            let _in_flight = entry.part_started();
            let src = Source { bucket: &bucket, key: &key, version_id: version_id.as_deref() };
            fetch_part(&client, &entry, src, etag.as_deref(), file, span, &token).await?;
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
    Ok(())
}

/// Downloads `span` into `file` at its offsets. Retries transient (Network) failures within the
/// part's [`RetryPolicy`]; a retry resumes after the last byte received (so `transferredBytes`
/// never goes backwards). An error that arrives after every byte of the span was received (a
/// connection reset or idle timeout after the final byte) completes the part instead of asking
/// for an empty range; a checksum mismatch is never such an error (it is not `Network`).
/// Returns once every byte of the span has been handed to the OS.
#[allow(clippy::too_many_arguments)]
async fn fetch_part(
    client: &Client,
    entry: &TransferEntry,
    src: Source<'_>,
    etag: Option<&str>,
    file: Arc<std::fs::File>,
    span: Span,
    token: &CancellationToken,
) -> AppResult<()> {
    let mut w = PartWriter::new(file, span.start, span.write_batch());
    let mut policy = RetryPolicy::new(span.len);
    let end = span.start + span.len;
    loop {
        let before = w.next;
        let e = match attempt(client, entry, src, etag, span, &mut w, token).await {
            Ok(()) => return w.flush().await,
            Err(e) => e,
        };
        if e.code == ErrorCode::Network && w.next == end {
            // Everything was received (range- and length-checked, pinned by If-Match); only the
            // end of the stream failed. Nothing is left to fetch.
            return w.flush().await;
        }
        let decision = if e.code == ErrorCode::Network {
            policy.after_failure(end - before, w.next - before)
        } else {
            RetryDecision::GiveUp
        };
        let RetryDecision::Retry(pause) = decision else {
            // Cancelled or fatal: the temp file is about to be deleted, so only let the write
            // in flight finish (never leave one running against it) instead of flushing.
            let _ = w.wait().await;
            return Err(e);
        };
        // Everything received is valid (pinned by If-Match and range-checked), so it is
        // written out and the retry starts after it.
        w.flush().await?;
        entry.note_retry(0);
        cancellable(token, tokio::time::sleep(pause)).await?;
    }
}

/// Deletes a download's temp file when dropped while it still holds a path (panic or a dropped
/// future); the normal paths remove or rename it themselves.
struct RemoveOnDrop(Option<PathBuf>);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// One GET for the rest of `span` (from `w.next`), streamed into `w`. Cancellation is checked
/// on every network wait; writes are never abandoned half-way.
#[allow(clippy::too_many_arguments)]
async fn attempt(
    client: &Client,
    entry: &TransferEntry,
    src: Source<'_>,
    etag: Option<&str>,
    span: Span,
    w: &mut PartWriter,
    token: &CancellationToken,
) -> AppResult<()> {
    let done = w.next - span.start;
    let end = span.start + span.len;
    if span.len > 0 && done >= span.len {
        return Ok(()); // nothing left (never request an empty range)
    }
    let resp = cancellable(
        token,
        client
            .get_object()
            .bucket(src.bucket)
            .key(src.key)
            .set_version_id(src.version_id.map(str::to_string))
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
    fn retry_policy_counts_only_meaningful_progress() {
        const K: u64 = 1024;
        let retry = |n: u64| RetryDecision::Retry(Duration::from_millis(500 * n));
        // No progress: gives up on the 3rd consecutive failure.
        let mut p = RetryPolicy::new(8 * MIB);
        assert_eq!(p.after_failure(8 * MIB, 0), retry(1));
        assert_eq!(p.after_failure(8 * MIB, 0), retry(2));
        assert_eq!(p.after_failure(8 * MIB, 0), RetryDecision::GiveUp);
        // A few bytes per attempt is not progress (it used to reset the count every time).
        let mut p = RetryPolicy::new(8 * MIB);
        assert_eq!(p.after_failure(8 * MIB, 1), retry(1));
        assert_eq!(p.after_failure(8 * MIB - 1, 64 * K - 1), retry(2));
        assert_eq!(p.after_failure(8 * MIB - 64 * K, 1), RetryDecision::GiveUp);
        // >= 64 KiB is progress: the consecutive count restarts.
        let mut p = RetryPolicy::new(8 * MIB);
        assert_eq!(p.after_failure(8 * MIB, 0), retry(1));
        assert_eq!(p.after_failure(8 * MIB, 0), retry(2));
        assert_eq!(p.after_failure(8 * MIB, 64 * K), retry(1));
        // Less than 64 KiB left: delivering all of the remainder is progress, less is not.
        let mut p = RetryPolicy::new(100);
        assert_eq!(p.after_failure(100, 0), retry(1));
        assert_eq!(p.after_failure(100, 99), retry(2));
        let mut p = RetryPolicy::new(100);
        assert_eq!(p.after_failure(100, 0), retry(1));
        assert_eq!(p.after_failure(100, 0), retry(2));
        assert_eq!(p.after_failure(10, 10), retry(1));
    }

    #[test]
    fn retry_policy_has_a_total_budget() {
        // 3 + ceil(len / 1 MiB) attempts, even if every one makes progress.
        assert_eq!(RetryPolicy::new(0).max_attempts, 3);
        assert_eq!(RetryPolicy::new(1).max_attempts, 4);
        assert_eq!(RetryPolicy::new(MIB).max_attempts, 4);
        assert_eq!(RetryPolicy::new(MIB + 1).max_attempts, 5);
        assert_eq!(RetryPolicy::new(16 * MIB).max_attempts, 19);
        assert_eq!(RetryPolicy::new(5 * 1024 * MIB).max_attempts, MAX_PART_ATTEMPTS, "capped");
        let mut p = RetryPolicy::new(2 * MIB); // 5 attempts
        let mut left = 2 * MIB;
        let mut decisions = Vec::new();
        for _ in 0..5 {
            decisions.push(p.after_failure(left, 64 * 1024));
            left -= 64 * 1024;
        }
        assert!(decisions[..4].iter().all(|d| matches!(d, RetryDecision::Retry(_))), "{decisions:?}");
        assert_eq!(decisions[4], RetryDecision::GiveUp);
    }

    #[test]
    fn range_header_never_inverted() {
        let part = Span { start: 100, len: 50, whole: false };
        assert_eq!(part.range_header(49).as_deref(), Some("bytes=149-149"));
        // Everything received: no range at all (it used to be "bytes=150-149").
        assert_eq!(part.range_header(50), None);
        assert_eq!(part.range_header(51), None);
        let whole = Span { start: 0, len: 1000, whole: true };
        assert_eq!(whole.range_header(1000), None);
        for len in [1u64, 2, 50, 1000] {
            for done in 0..=len + 1 {
                if let Some(r) = (Span { start: 7, len, whole: false }).range_header(done) {
                    let (a, b) = r.strip_prefix("bytes=").and_then(|x| x.split_once('-')).expect("range");
                    assert!(a.parse::<u64>().expect("a") <= b.parse::<u64>().expect("b"), "{r}");
                }
            }
        }
    }

    #[tokio::test]
    async fn a_checksum_mismatch_is_not_retryable() {
        use aws_sdk_s3::primitives::ByteStream;
        use aws_smithy_checksums::body::validate::ChecksumBody;
        use aws_smithy_checksums::ChecksumAlgorithm;
        use aws_smithy_types::body::SdkBody;

        let algo: ChecksumAlgorithm = "crc32".parse().expect("crc32");
        let bad = ChecksumBody::new(SdkBody::from("some data"), algo.into_impl(), bytes::Bytes::from_static(&[0, 0, 0, 0]));
        let mut body = ByteStream::new(SdkBody::from_body_1_x(bad));
        let mut got = Vec::new();
        let err = loop {
            match next_chunk(&mut body).await {
                Ok(Some(c)) => got.extend_from_slice(&c),
                Ok(None) => panic!("mismatch not reported"),
                Err(e) => break e,
            }
        };
        assert_eq!(got, b"some data", "the error comes after the last byte");
        assert_eq!(err.code, ErrorCode::Unknown, "{err:?}");
        assert!(err.message.contains("checksum"), "{}", err.message);
        // A plain transport error stays retryable.
        let io: Box<dyn std::error::Error + Send + Sync> = Box::new(std::io::Error::other("reset"));
        assert!(!is_checksum_mismatch(&*io));
    }

    /// L2 (review): a 250-character name still gets a temp file that can be created.
    #[test]
    fn part_path_fits_long_names() {
        use crate::testutil::ScratchDir;
        let dir = ScratchDir::new("part-long");
        for name in ["a".repeat(250), "é".repeat(120) + ".bin", "b".repeat(241)] {
            let dest = dir.0.join(&name);
            let tmp = part_path(&dest, "0123456789abcdef");
            let tmp_name = tmp.file_name().unwrap().to_string_lossy().into_owned();
            assert!(tmp_name.len() <= 255 && tmp_name.ends_with(".01234567.part"), "{} bytes", tmp_name.len());
            assert_eq!(tmp.parent(), dest.parent());
            create_tmp(&tmp).expect("temp file can be created");
            assert_ne!(part_path(&dest, "fedcba9876543210"), tmp, "still unique per transfer");
        }
    }

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

    #[cfg(windows)]
    #[test]
    fn verbatim_paths() {
        assert_eq!(verbatim(Path::new(r"C:\dl\a.txt")), OsString::from(r"\\?\C:\dl\a.txt"));
        assert_eq!(verbatim(Path::new("C:/dl/./sub/a.txt")), OsString::from(r"\\?\C:\dl\sub\a.txt"));
        assert_eq!(verbatim(Path::new(r"\\srv\share\d\f")), OsString::from(r"\\?\UNC\srv\share\d\f"));
        assert_eq!(verbatim(Path::new(r"\\?\C:\x")), OsString::from(r"\\?\C:\x"));
        assert_eq!(verbatim(Path::new(r"C:\a\..\b")), OsString::from(r"C:\a\..\b"));
        assert_eq!(verbatim(Path::new(r"rel\x")), OsString::from(r"rel\x"));
    }

    #[test]
    fn rename_no_replace_handles_long_paths() {
        let dir = std::env::temp_dir().join(format!("s3x-long-{}", uuid::Uuid::new_v4()));
        let deep = (0..6).fold(dir.clone(), |p, i| p.join(format!("{i}{}", "d".repeat(60))));
        std::fs::create_dir_all(&deep).unwrap();
        let (a, b) = (deep.join("x.part"), deep.join("x.bin"));
        assert!(b.as_os_str().len() > 300, "{}", b.as_os_str().len());
        std::fs::write(&a, b"long").unwrap();
        rename_no_replace(&a, &b).expect("long-path rename");
        assert_eq!(std::fs::read(&b).unwrap(), b"long");
        std::fs::write(&a, b"again").unwrap();
        assert_eq!(rename_no_replace(&a, &b).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_no_replace_never_replaces() {
        let dir = std::env::temp_dir().join(format!("s3x-norepl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.part"), dir.join("b.txt"));
        std::fs::write(&a, b"new").unwrap();
        std::fs::write(&b, b"old").unwrap();
        let e = rename_no_replace(&a, &b).expect_err("must not replace");
        assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists, "{e:?}");
        assert_eq!(std::fs::read(&b).unwrap(), b"old", "existing file untouched");
        assert_eq!(std::fs::read(&a).unwrap(), b"new", "source kept for the caller to remove");
        // A directory in the way counts as existing too.
        let d = dir.join("sub");
        std::fs::create_dir(&d).unwrap();
        assert!(rename_no_replace(&a, &d).is_err());
        // Free destination: renamed, source gone.
        let c = dir.join("c.txt");
        rename_no_replace(&a, &c).expect("rename");
        assert_eq!(std::fs::read(&c).unwrap(), b"new");
        assert!(!a.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// H1 (review): the run-time re-check catches a link that appeared after planning, at the
    /// file or on the way, and a parent whose real location is outside the root.
    #[test]
    fn run_time_link_checks() {
        use crate::testutil::{dir_link, ScratchDir};
        let dir = ScratchDir::new("dl-runtime-link");
        let (root, outside) = (dir.0.join("root"), dir.0.join("outside"));
        std::fs::create_dir_all(root.join("plain")).expect("root");
        std::fs::create_dir_all(&outside).expect("outside");
        assert!(refuse_links(&root, &root.join("plain").join("f.txt")).is_ok());
        assert!(refuse_links(&root, &root.join("not-yet").join("deeper").join("f.txt")).is_ok());
        assert!(require_inside(&root, &root.join("plain")).is_ok());
        dir_link(&root.join("j"), &outside);
        let e = refuse_links(&root, &root.join("j").join("sub").join("f.txt")).expect_err("link on the way");
        assert!(e.message.contains("is a link to another location") && e.message.contains("j"), "{}", e.message);
        let e = refuse_links(&root, &root.join("j")).expect_err("the file itself is a link");
        assert!(e.message.contains("is a link"), "{}", e.message);
        let e = require_inside(&root, &root.join("j")).expect_err("real folder is outside");
        assert!(e.message.contains("leads outside"), "{}", e.message);
        // The root itself may be a link (the user chose it).
        dir_link(&dir.0.join("root-link"), &root);
        assert!(refuse_links(&dir.0.join("root-link"), &dir.0.join("root-link").join("plain").join("f")).is_ok());
        assert!(require_inside(&dir.0.join("root-link"), &dir.0.join("root-link").join("plain")).is_ok());
        assert!(std::fs::read_dir(&outside).expect("outside").next().is_none(), "nothing created outside");
        std::fs::remove_dir(root.join("j")).expect("unlink");
        std::fs::remove_dir(dir.0.join("root-link")).expect("unlink");
    }
}
