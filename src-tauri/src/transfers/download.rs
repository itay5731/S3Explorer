//! Parallel ranged download into a pre-sized `.part` file.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::Client;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::{cancellable, plan, write_all_at, PartSettings, TransferEntry};
use crate::error::{AppError, AppResult, ErrorCode};

const PART_ATTEMPTS: u32 = 3;
/// A response body that delivers no bytes for this long is treated as a (retryable) network error.
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

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
        single(client, entry, bucket, key, etag.as_deref(), size, file, &token).await
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

/// Single streaming GET for small objects. Pinned to the HEAD's ETag and checked against its size,
/// so a concurrent overwrite fails the transfer instead of overrunning `totalBytes`.
#[allow(clippy::too_many_arguments)]
async fn single(
    client: &Client,
    entry: &TransferEntry,
    bucket: &str,
    key: &str,
    etag: Option<&str>,
    size: u64,
    file: std::fs::File,
    token: &CancellationToken,
) -> AppResult<()> {
    let resp = cancellable(
        token,
        client.get_object().bucket(bucket).key(key).set_if_match(etag.map(str::to_string)).send(),
    )
    .await??;
    let changed = || AppError::new(ErrorCode::Unknown, "The object changed during the download; try again");
    if resp.content_length().is_some_and(|n| n.max(0) as u64 != size) {
        return Err(changed());
    }
    let mut body = resp.body;
    let mut file = tokio::fs::File::from_std(file);
    let mut received = 0u64;
    while let Some(chunk) = cancellable(token, next_chunk(&mut body)).await?? {
        received += chunk.len() as u64;
        if received > size {
            return Err(changed());
        }
        file.write_all(&chunk).await?;
        entry.add_bytes(chunk.len() as u64);
    }
    if received != size {
        return Err(AppError::new(ErrorCode::Network, format!("Short read: got {received} of {size} bytes")));
    }
    file.flush().await?;
    Ok(())
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
        let end = (start + part_size).min(size) - 1;
        let (client, entry, file, token) = (client.clone(), entry.clone(), file.clone(), token.clone());
        let (bucket, key, etag) = (bucket.to_string(), key.to_string(), etag.clone());
        set.spawn(async move {
            let _permit = permit;
            let _in_flight = entry.part_started();
            let buf = fetch_range(&client, &entry, &bucket, &key, etag.as_deref(), start, end, &token).await?;
            let file2 = file.clone();
            tokio::task::spawn_blocking(move || write_all_at(&file2, &buf, start)).await??;
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

/// GETs `bytes=start-end` into memory, retrying transient failures.
#[allow(clippy::too_many_arguments)]
async fn fetch_range(
    client: &Client,
    entry: &TransferEntry,
    bucket: &str,
    key: &str,
    etag: Option<&str>,
    start: u64,
    end: u64,
    token: &CancellationToken,
) -> AppResult<Vec<u8>> {
    let len = (end - start + 1) as usize;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut counted = 0u64;
        let res = cancellable(token, async {
            let resp = client
                .get_object()
                .bucket(bucket)
                .key(key)
                .range(format!("bytes={start}-{end}"))
                .set_if_match(etag.map(str::to_string))
                .send()
                .await?;
            // Refuse to buffer anything but exactly the requested range: a server that ignores
            // `Range` would otherwise stream the whole object into memory once per part.
            let range_mismatch = |what: String| {
                AppError::new(ErrorCode::Unknown, format!("Server did not honor the byte range {start}-{end}: {what}"))
            };
            if let Some(n) = resp.content_length() {
                if n.max(0) as usize != len {
                    return Err(range_mismatch(format!("Content-Length {n}, expected {len}")));
                }
            }
            if let Some(cr) = resp.content_range() {
                if !cr.starts_with(&format!("bytes {start}-{end}/")) {
                    return Err(range_mismatch(format!("Content-Range {cr}")));
                }
            }
            let mut body = resp.body;
            let mut buf = Vec::with_capacity(len);
            while let Some(chunk) = next_chunk(&mut body).await? {
                if buf.len() + chunk.len() > len {
                    return Err(range_mismatch(format!("more than {len} bytes received")));
                }
                buf.extend_from_slice(&chunk);
                entry.add_bytes(chunk.len() as u64);
                counted += chunk.len() as u64;
            }
            if buf.len() != len {
                return Err(AppError::new(
                    ErrorCode::Network,
                    format!("Short read for bytes {start}-{end}: got {} of {len} bytes", buf.len()),
                ));
            }
            Ok::<_, AppError>(buf)
        })
        .await?;
        match res {
            Ok(buf) => return Ok(buf),
            Err(e) => {
                entry.sub_bytes(counted);
                if attempt >= PART_ATTEMPTS || e.code != ErrorCode::Network {
                    return Err(e);
                }
                cancellable(token, tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt)))).await?;
            }
        }
    }
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
}
