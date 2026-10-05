//! Upload: `PutObject` for small files, concurrent multipart upload for large ones.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use aws_config::timeout::TimeoutConfig;
use aws_sdk_s3::primitives::{ByteStream, Length};
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::{cancellable, plan, AbortOnDrop, PartSettings, TransferEntry};
use crate::error::{AppError, AppResult, ErrorCode};

/// Slowest uplink assumed healthy: 32 KiB/s (256 kbit/s) in total, shared evenly by every
/// body-carrying request the app may have in flight at once.
pub(crate) const UPLOAD_MIN_RATE: u64 = 32 * 1024;
/// Fixed allowance per attempt (connection setup, the server committing the data, latency).
const UPLOAD_TIMEOUT_BASE: Duration = Duration::from_secs(60);
const UPLOAD_TIMEOUT_MAX: Duration = Duration::from_secs(6 * 60 * 60);

/// Per-attempt bound for a request carrying `body_len` bytes when up to `share` such requests
/// may run at once: `60 s + body_len * share / 32 KiB/s`, at most 6 h. A healthy link at or above
/// the assumed rate always sends the body and gets the answer within it; a server that takes the
/// whole body and then never answers is cut off instead of waiting forever.
pub(crate) fn upload_attempt_timeout(body_len: u64, share: u64) -> Duration {
    let secs = body_len.saturating_mul(share.max(1)).div_ceil(UPLOAD_MIN_RATE);
    UPLOAD_TIMEOUT_BASE.saturating_add(Duration::from_secs(secs)).min(UPLOAD_TIMEOUT_MAX)
}

/// Config override for requests that carry a body (PutObject, UploadPart).
///
/// The SDK's `read_timeout` (30 s, see `state.rs`) runs from the start of a request until the
/// response headers arrive, so it also covers *sending* the body. On a slow uplink a part can
/// legitimately take minutes to send (100 MiB at 190 KiB/s is ~9 min), and every attempt would
/// time out and start the part over. These requests replace it with an `operation_attempt_timeout`
/// scaled to the body size ([`upload_attempt_timeout`]). The SDK still retries a timed-out
/// attempt (the body is re-read from disk); the connect timeout is inherited from the client.
fn body_upload_config(cfg: &PartSettings, body_len: u64) -> aws_sdk_s3::config::Builder {
    let t = cfg.upload_attempt_timeout.unwrap_or_else(|| upload_attempt_timeout(body_len, cfg.link_share));
    aws_sdk_s3::config::Builder::default()
        .timeout_config(TimeoutConfig::builder().disable_read_timeout().operation_attempt_timeout(t).build())
}

pub(super) async fn run(
    client: &Client,
    entry: &Arc<TransferEntry>,
    cfg: PartSettings,
    bucket: &str,
    key: &str,
    src: &Path,
) -> AppResult<()> {
    if key.is_empty() {
        return Err(AppError::invalid("Object key is required"));
    }
    let meta = tokio::fs::metadata(src).await?;
    if !meta.is_file() {
        return Err(AppError::invalid(format!("Not a file: {}", src.display())));
    }
    let size = meta.len();
    let content_type = mime_guess::from_path(src).first_or_octet_stream().essence_str().to_string();
    let token = entry.cancel.child_token();

    let p = plan::plan_upload(size, cfg.part_size_mib);
    entry.set_totals(size, p.parts_total());
    if !p.multipart {
        let _in_flight = entry.part_started();
        let body = ByteStream::from_path(src).await?;
        cancellable(
            &token,
            client
                .put_object()
                .bucket(bucket)
                .key(key)
                .content_type(content_type)
                .content_length(size as i64)
                .body(body)
                .customize()
                .config_override(body_upload_config(&cfg, size))
                .send(),
        )
        .await??;
        entry.add_bytes(size);
        entry.part_done();
        return Ok(());
    }

    let (part_size, parts) = (p.part_size, p.parts);

    if token.is_cancelled() {
        return Err(AppError::cancelled());
    }
    // Not cancellable: dropping it mid-flight could leave an upload id we never learn about
    // (and so can never abort). Cancellation is checked right after instead.
    let created = client.create_multipart_upload().bucket(bucket).key(key).content_type(content_type).send().await?;
    let upload_id = created
        .upload_id()
        .map(str::to_string)
        .ok_or_else(|| AppError::new(ErrorCode::Unknown, "S3 did not return an upload id"))?;
    // Aborts the upload even if this future is dropped or panics before the end.
    let mut guard = AbortOnDrop::new(client, bucket, key, &upload_id);

    let result = async {
        if token.is_cancelled() {
            return Err(AppError::cancelled());
        }
        let completed = upload_parts(client, entry, cfg, bucket, key, &upload_id, src, size, part_size, parts, &token).await?;
        // Not cancellable either: once all parts are up, let Complete finish so the reported
        // status always matches whether the object was actually committed.
        client
            .complete_multipart_upload()
            .bucket(bucket)
            .key(key)
            .upload_id(&upload_id)
            .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(completed)).build())
            .send()
            .await?;
        Ok::<_, AppError>(())
    }
    .await;

    if let Err(e) = result {
        // Best effort; deliberately not cancellable.
        guard.abort().await;
        return Err(if entry.cancel.is_cancelled() { AppError::cancelled() } else { e });
    }
    guard.disarm();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upload_parts(
    client: &Client,
    entry: &Arc<TransferEntry>,
    cfg: PartSettings,
    bucket: &str,
    key: &str,
    upload_id: &str,
    src: &Path,
    size: u64,
    part_size: u64,
    parts: u64,
    token: &CancellationToken,
) -> AppResult<Vec<CompletedPart>> {
    let sem = Arc::new(Semaphore::new(cfg.max_parts.max(1)));
    let mut set: JoinSet<AppResult<(i32, String)>> = JoinSet::new();
    let mut etags: Vec<Option<String>> = vec![None; parts as usize];
    let mut first_err: Option<AppError> = None;

    let note = |r: Result<AppResult<(i32, String)>, tokio::task::JoinError>,
                etags: &mut Vec<Option<String>>,
                first_err: &mut Option<AppError>| {
        match r.map_err(AppError::from).and_then(|x| x) {
            Ok((n, etag)) => {
                if let Some(slot) = etags.get_mut((n - 1) as usize) {
                    *slot = Some(etag);
                }
            }
            Err(e) => {
                token.cancel();
                if first_err.is_none() || first_err.as_ref().is_some_and(|f| f.is_cancelled() && !e.is_cancelled()) {
                    *first_err = Some(e);
                }
            }
        }
    };

    for i in 0..parts {
        while let Some(r) = set.try_join_next() {
            note(r, &mut etags, &mut first_err);
        }
        if first_err.is_some() || token.is_cancelled() {
            break;
        }
        let permit = match cancellable(token, sem.clone().acquire_owned()).await {
            Ok(Ok(p)) => p,
            _ => break,
        };
        let offset = i * part_size;
        let len = part_size.min(size - offset);
        let part_number = (i + 1) as i32;
        let (client, entry, token) = (client.clone(), entry.clone(), token.clone());
        let (bucket, key, upload_id, src) = (bucket.to_string(), key.to_string(), upload_id.to_string(), src.to_path_buf());
        set.spawn(async move {
            let _permit = permit;
            let _in_flight = entry.part_started();
            // Stream the part straight from disk instead of buffering it: memory stays flat no
            // matter how large the parts get, and a path-backed body is replayable for SDK retries.
            let body = ByteStream::read_from()
                .path(&src)
                .offset(offset)
                .length(Length::Exact(len))
                .build()
                .await
                .map_err(|e| AppError::new(ErrorCode::Io, format!("Could not read {}: {e}", src.display())))?;
            let resp = cancellable(
                &token,
                client
                    .upload_part()
                    .bucket(bucket)
                    .key(key)
                    .upload_id(upload_id)
                    .part_number(part_number)
                    .content_length(len as i64)
                    .body(body)
                    .customize()
                    .config_override(body_upload_config(&cfg, len))
                    .send(),
            )
            .await??;
            let etag = resp
                .e_tag()
                .map(str::to_string)
                .ok_or_else(|| AppError::new(ErrorCode::Unknown, format!("No ETag returned for part {part_number}")))?;
            entry.add_bytes(len);
            entry.part_done();
            Ok((part_number, etag))
        });
    }
    while let Some(r) = set.join_next().await {
        note(r, &mut etags, &mut first_err);
    }

    if let Some(e) = first_err {
        return Err(e);
    }
    if token.is_cancelled() {
        return Err(AppError::cancelled());
    }
    etags
        .into_iter()
        .enumerate()
        .map(|(i, etag)| {
            let etag = etag.ok_or_else(|| AppError::new(ErrorCode::Unknown, format!("Part {} missing", i + 1)))?;
            Ok(CompletedPart::builder().part_number((i + 1) as i32).e_tag(etag).build())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfers::MIB;

    #[test]
    fn attempt_timeout_scales_with_body_and_sharing() {
        let secs = |len, share| upload_attempt_timeout(len, share).as_secs();
        assert_eq!(secs(0, 1), 60);
        assert_eq!(secs(32 * 1024, 1), 61);
        assert_eq!(secs(1, 1), 61, "rounded up");
        // 8 MiB alone at 32 KiB/s takes 256 s.
        assert_eq!(secs(8 * MIB, 1), 60 + 256);
        // Defaults (8 parts x 4 transfers): each request may get 1/32 of the link.
        assert_eq!(secs(8 * MIB, 32), 60 + 256 * 32);
        assert_eq!(secs(8 * MIB, 0), secs(8 * MIB, 1), "share is at least 1");
        // Clamped to 6 h; no overflow.
        assert_eq!(secs(5 * 1024 * MIB, 320), 6 * 3600);
        assert_eq!(secs(u64::MAX, u64::MAX), 6 * 3600);
        // The old fixed 30 s read timeout was shorter than the time to send even one 8 MiB part
        // on a link this slow; the new bound never is (base > 0 and rate <= the assumed minimum).
        for len in [MIB, 8 * MIB, 64 * MIB] {
            for share in [1, 8, 32] {
                let send = len * share / UPLOAD_MIN_RATE;
                assert!(secs(len, share) > send || secs(len, share) == 6 * 3600);
            }
        }
    }
}
