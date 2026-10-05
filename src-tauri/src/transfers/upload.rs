//! Upload: `PutObject` for small files, concurrent multipart upload for large ones.

use std::path::Path;
use std::sync::Arc;

use aws_config::timeout::TimeoutConfig;
use aws_sdk_s3::primitives::{ByteStream, Length};
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::{cancellable, plan, PartSettings, TransferEntry};
use crate::error::{AppError, AppResult, ErrorCode};

/// Config override for requests that carry a body (PutObject, UploadPart).
///
/// The SDK's `read_timeout` (30 s, see `state.rs`) runs from the start of a request until the
/// response headers arrive, so it also covers *sending* the body. On a slow uplink a part can
/// legitimately take minutes to send (100 MiB at 190 KiB/s is ~9 min), and every attempt would
/// time out and start the part over. These requests run without it: a dead connection still
/// fails through TCP, and a body that stops producing data through stalled-stream protection.
fn body_upload_config() -> aws_sdk_s3::config::Builder {
    aws_sdk_s3::config::Builder::default().timeout_config(TimeoutConfig::builder().disable_read_timeout().build())
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
                .config_override(body_upload_config())
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

    let result = async {
        if token.is_cancelled() {
            return Err(AppError::cancelled());
        }
        let completed = upload_parts(client, entry, bucket, key, &upload_id, src, size, part_size, parts, cfg.max_parts, &token)
                .await?;
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
        let _ = client.abort_multipart_upload().bucket(bucket).key(key).upload_id(&upload_id).send().await;
        return Err(if entry.cancel.is_cancelled() { AppError::cancelled() } else { e });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upload_parts(
    client: &Client,
    entry: &Arc<TransferEntry>,
    bucket: &str,
    key: &str,
    upload_id: &str,
    src: &Path,
    size: u64,
    part_size: u64,
    parts: u64,
    max_parts: usize,
    token: &CancellationToken,
) -> AppResult<Vec<CompletedPart>> {
    let sem = Arc::new(Semaphore::new(max_parts.max(1)));
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
                    .config_override(body_upload_config())
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
