//! The S3 side of jobs: listing phase (prefix expansion, conflict detection) and working phase
//! (batched deletes, copies, multipart copies, move = copy then delete the source).
//!
//! No Tauri types here; progress goes to a [`JobEntry`](super::JobEntry).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use aws_config::timeout::TimeoutConfig;
use aws_sdk_s3::config::http::HttpResponse;
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart, Delete, MetadataDirective, ObjectIdentifier, StorageClass};
use aws_sdk_s3::Client;
use futures::stream::{self, FuturesUnordered, StreamExt, TryStreamExt};
use tokio_util::sync::CancellationToken;

use super::plan::{encode_copy_source, plan_copy_parts, Expansion, ItemListing, Listed, Planned};
use super::{JobEntry, JobTuning};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{ConflictPolicy, JobError, JobKind, JobRequest};
use crate::ops::{listing_error, next_list_page, NextPage};
use crate::transfers::AbortOnDrop;

/// Object operations in flight per job (copies, or delete batches for a delete job count 1 each).
pub const OBJECT_CONCURRENCY: usize = 16;
/// Listing / HEAD requests in flight during the listing phase.
const LIST_CONCURRENCY: usize = 16;
/// `UploadPartCopy` requests in flight within one multipart copy.
const PART_CONCURRENCY: usize = 4;
/// Keys per `DeleteObjects` request (the S3 maximum).
pub const DELETE_BATCH: usize = 1000;
/// `DeleteObjects` requests in flight for a delete job.
const DELETE_CONCURRENCY: usize = 4;
/// A move deletes the sources of confirmed copies at least this often (or every 1,000 keys).
const SOURCE_DELETE_INTERVAL: Duration = Duration::from_millis(500);
/// Server-side copies answer only when done (up to 5 GiB per `CopyObject` / `UploadPartCopy`,
/// possibly across regions, with up to 16 copies sharing the server), so the connection's 30 s
/// read timeout would cut them off. Their bound scales with the bytes copied instead: this much
/// time plus the bytes at [`COPY_MIN_RATE`], clamped to [`COPY_TIMEOUT_MIN`, `COPY_TIMEOUT_MAX`].
const COPY_TIMEOUT_BASE: Duration = Duration::from_secs(5 * 60);
/// Assumed slowest healthy server-side copy rate per request (2 MiB/s: a 5 GiB copy may take ~43 min).
const COPY_MIN_RATE: u64 = 2 * 1024 * 1024;
/// Never less than the fixed 15 minutes used before.
const COPY_TIMEOUT_MIN: Duration = Duration::from_secs(15 * 60);
const COPY_TIMEOUT_MAX: Duration = Duration::from_secs(6 * 60 * 60);

/// The response wait and attempt bound for a server-side copy of `bytes` bytes.
pub(crate) fn copy_timeout_for(bytes: u64) -> Duration {
    (COPY_TIMEOUT_BASE + Duration::from_secs(bytes / COPY_MIN_RATE)).clamp(COPY_TIMEOUT_MIN, COPY_TIMEOUT_MAX)
}

pub(crate) struct Ctx<'a> {
    pub req: &'a JobRequest,
    pub src: &'a Client,
    pub dest: Option<&'a Client>,
    pub cancel: &'a CancellationToken,
    pub tuning: &'a JobTuning,
}

impl Ctx<'_> {
    fn dest_bucket(&self) -> &str {
        self.req.dest_bucket.as_deref().unwrap_or_default()
    }
    fn same_bucket(&self) -> bool {
        self.req.dest_bucket.as_deref() == Some(self.req.src_bucket.as_str())
    }
    fn dest_client(&self) -> AppResult<&Client> {
        self.dest.ok_or_else(|| AppError::invalid("destBucket is required"))
    }
}

async fn cancellable<T>(token: &CancellationToken, f: impl std::future::Future<Output = T>) -> AppResult<T> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(AppError::cancelled()),
        v = f => Ok(v),
    }
}

/// Config override for a copy of `bytes` bytes: no request body, so the read timeout (time to
/// the response) and the per-attempt timeout get the same size-scaled bound; SDK retries still
/// apply (an attempt timeout is a retryable error). The connect timeout is inherited.
fn copy_timeout(bytes: u64) -> aws_sdk_s3::config::Builder {
    let t = copy_timeout_for(bytes);
    aws_sdk_s3::config::Builder::default()
        .timeout_config(TimeoutConfig::builder().read_timeout(t).operation_attempt_timeout(t).build())
}

/// HTTP status and S3 error code of a failed request.
fn err_info<E: ProvideErrorMetadata>(e: &SdkError<E, HttpResponse>) -> (Option<u16>, Option<String>) {
    let status = e.raw_response().map(|r| r.status().as_u16());
    let code = e.as_service_error().and_then(|s| s.code()).map(str::to_string);
    (status, code)
}

// ---- listing phase --------------------------------------------------------------------------

/// Lists every key under `prefix` (no delimiter, all pages). With a `budget` (shared by
/// concurrent listings) it stops once the budget is used up; the flag is true when it stopped
/// before the end. Paging follows [`next_list_page`]: a continuation token is followed even when
/// `IsTruncated` is missing, and a truncated page without a token, or a token the server already
/// sent, is an error (silently stopping would under-count sources and existing destinations).
pub(crate) async fn list_prefix(
    client: &Client,
    bucket: &str,
    prefix: &str,
    cancel: &CancellationToken,
    budget: Option<&AtomicI64>,
    on_page: &(dyn Fn(u64) + Sync),
) -> AppResult<(Vec<Listed>, bool)> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        if budget.is_some_and(|b| b.load(Ordering::Relaxed) <= 0) {
            return Ok((out, true));
        }
        let resp = cancellable(
            cancel,
            client.list_objects_v2().bucket(bucket).prefix(prefix).set_continuation_token(token.clone()).send(),
        )
        .await??;
        let before = out.len();
        out.extend(resp.contents().iter().filter_map(|o| {
            Some(Listed {
                key: o.key()?.to_string(),
                size: o.size().unwrap_or(0).max(0) as u64,
                etag: o.e_tag().map(str::to_string),
                storage_class: o.storage_class().map(|s| s.as_str().to_string()),
            })
        }));
        let added = (out.len() - before) as u64;
        on_page(added);
        if let Some(b) = budget {
            b.fetch_sub(added as i64, Ordering::Relaxed);
        }
        match next_list_page(resp.is_truncated(), resp.next_continuation_token(), |t| seen.contains(t)) {
            NextPage::Done => return Ok((out, false)),
            NextPage::Continue(t) => {
                seen.insert(t.clone());
                token = Some(t);
            }
            NextPage::Error(why) => return Err(listing_error(bucket, prefix, why)),
        }
    }
}

/// `HeadObject`; `None` when the key does not exist.
async fn head(client: &Client, bucket: &str, key: &str, cancel: &CancellationToken) -> AppResult<Option<Listed>> {
    match cancellable(cancel, client.head_object().bucket(bucket).key(key).send()).await? {
        Ok(h) => Ok(Some(Listed {
            key: key.to_string(),
            size: h.content_length().unwrap_or(0).max(0) as u64,
            etag: h.e_tag().map(str::to_string),
            storage_class: h.storage_class().map(|s| s.as_str().to_string()),
        })),
        Err(e) => {
            let err = AppError::from(e);
            if err.code == ErrorCode::NoSuchKey {
                Ok(None)
            } else {
                Err(AppError::new(err.code, format!("{key}: {}", err.message)))
            }
        }
    }
}

/// Expands every item (in request order, de-duplicated). `head_objects` looks single objects up
/// (copy/move need their size and ETag; delete does not). With a `cap`, stops after `cap`
/// objects and reports `truncated`.
pub(crate) async fn expand(
    ctx: &Ctx<'_>,
    head_objects: bool,
    cap: Option<u64>,
    on_page: &(dyn Fn(u64) + Sync),
) -> AppResult<(Expansion, bool)> {
    let req = ctx.req;
    // One extra so "more than cap" is detectable.
    let budget = cap.map(|c| AtomicI64::new(c.saturating_add(1).min(i64::MAX as u64) as i64));
    let budget = budget.as_ref();
    // Index-based closures: closures taking references trip a compiler limitation with Send futures.
    let fetches = stream::iter(0..req.items.len())
        .map(move |i| {
            let it = &req.items[i];
            async move {
                let (listing, stopped) = if it.is_prefix {
                    let (keys, stopped) =
                        list_prefix(ctx.src, &req.src_bucket, &it.from, ctx.cancel, budget, on_page).await?;
                    (ItemListing::Prefix(keys), stopped)
                } else if head_objects {
                    if budget.is_some_and(|b| b.load(Ordering::Relaxed) <= 0) {
                        return Ok::<_, AppError>((i, it, None));
                    }
                    let found = head(ctx.src, &req.src_bucket, &it.from, ctx.cancel).await?;
                    if found.is_some() {
                        on_page(1);
                        if let Some(b) = budget {
                            b.fetch_sub(1, Ordering::Relaxed);
                        }
                    }
                    (ItemListing::Object(found), false)
                } else {
                    on_page(1);
                    (ItemListing::Unchecked, false)
                };
                Ok((i, it, Some((listing, stopped))))
            }
        })
        .buffered(LIST_CONCURRENCY);
    tokio::pin!(fetches);
    let mut exp = Expansion::default();
    let mut truncated = false;
    while let Some(r) = fetches.next().await {
        let (i, it, got) = r?;
        let Some((listing, stopped)) = got else {
            truncated = true;
            continue;
        };
        if stopped {
            truncated = true;
            // A listing cut short by the budget is not "nothing found".
            if matches!(&listing, ItemListing::Prefix(k) if k.is_empty()) {
                continue;
            }
        }
        exp.add(i, it, req.kind, listing);
        if let Some(c) = cap {
            if exp.work.len() as u64 > c {
                exp.work.truncate(c as usize);
                truncated = true;
                break;
            }
        }
    }
    Ok((exp, truncated))
}

/// Per-object error for a move whose source has no ETag (none in the listing nor from `HeadObject`).
pub(crate) const NO_ETAG_FOR_MOVE: &str = "The server did not provide an ETag for this object, so the move could not be made safe (the copy and the delete of the original could not be tied to this exact version). The object was not moved.";

/// For a move, every source must have an ETag: it pins the copy (`x-amz-copy-source-if-match`)
/// and the delete of the original. Returns the objects that may proceed and per-object errors
/// for the others. A copy never deletes anything, so it proceeds without an ETag.
pub(crate) fn split_unmovable(kind: JobKind, work: Vec<Planned>) -> (Vec<Planned>, Vec<JobError>) {
    if kind != JobKind::Move {
        return (work, Vec::new());
    }
    let (ok, bad): (Vec<Planned>, Vec<Planned>) = work.into_iter().partition(|p| p.etag.as_deref().is_some_and(|e| !e.is_empty()));
    (ok, bad.into_iter().map(|p| JobError { key: p.src, message: NO_ETAG_FOR_MOVE.into() }).collect())
}

/// Listing phase of a move: sources the listing gave no ETag are looked up with `HeadObject`
/// (size, ETag and storage class are taken from it); a source that is gone by then is a
/// per-object failure; one still without an ETag is not moved (see [`split_unmovable`]).
/// A `HeadObject` error fails the job before any change, like any listing error.
pub(crate) async fn require_move_etags(ctx: &Ctx<'_>, exp: &mut Expansion) -> AppResult<()> {
    if ctx.req.kind != JobKind::Move {
        return Ok(());
    }
    let need: Vec<usize> =
        (0..exp.work.len()).filter(|&i| exp.work[i].etag.as_deref().is_none_or(str::is_empty)).collect();
    if !need.is_empty() {
        let work = &exp.work;
        let need = &need;
        let found: Vec<(usize, Option<Listed>)> = stream::iter(0..need.len())
            .map(move |n| async move {
                let i = need[n];
                Ok::<_, AppError>((i, head(ctx.src, &ctx.req.src_bucket, &work[i].src, ctx.cancel).await?))
            })
            .buffered(LIST_CONCURRENCY)
            .try_collect()
            .await?;
        let mut gone = HashSet::new();
        for (i, h) in found {
            match h {
                Some(h) => {
                    let p = &mut exp.work[i];
                    p.size = h.size;
                    p.etag = h.etag;
                    p.storage_class = h.storage_class.or(p.storage_class.take());
                }
                None => {
                    gone.insert(i);
                }
            }
        }
        if !gone.is_empty() {
            let mut i = 0;
            exp.work.retain(|p| {
                let keep = !gone.contains(&i);
                if !keep {
                    exp.missing.push(JobError { key: p.src.clone(), message: SOURCE_GONE.into() });
                }
                i += 1;
                keep
            });
        }
    }
    let (ok, errors) = split_unmovable(ctx.req.kind, std::mem::take(&mut exp.work));
    exp.work = ok;
    exp.missing.extend(errors);
    Ok(())
}

/// Destination keys of `exp` that already exist: each prefix item's destination prefix is
/// listed once and intersected; single-object items are checked with `HeadObject`.
pub(crate) async fn existing_dests(ctx: &Ctx<'_>, exp: &Expansion, cap: Option<u64>) -> AppResult<(HashSet<String>, bool)> {
    let dest = ctx.dest_client()?;
    let bucket = ctx.dest_bucket();
    let mut by_item: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
    for p in &exp.work {
        if let Some(d) = p.dest.as_deref() {
            by_item.entry(p.item).or_default().push(d);
        }
    }
    let budget = cap.map(|c| AtomicI64::new(c.min(i64::MAX as u64) as i64));
    let budget = budget.as_ref();
    let noop = |_: u64| {};
    let noop: &(dyn Fn(u64) + Sync) = &noop;
    let groups: Vec<(usize, Vec<&str>)> = by_item.into_iter().collect();
    let groups = &groups;
    let checks = stream::iter(0..groups.len())
        .map(move |g| {
            let (i, dests) = &groups[g];
            let it = &ctx.req.items[*i];
            async move {
                let mut found = Vec::new();
                let mut stopped = false;
                match it.to.as_deref() {
                    Some(to) if it.is_prefix => {
                        let (keys, s) = list_prefix(dest, bucket, to, ctx.cancel, budget, noop).await?;
                        stopped = s;
                        let listed: HashSet<String> = keys.into_iter().map(|l| l.key).collect();
                        found.extend(dests.iter().filter(|d| listed.contains(**d)).map(|d| d.to_string()));
                    }
                    _ => {
                        for d in dests {
                            if head(dest, bucket, d, ctx.cancel).await?.is_some() {
                                found.push(d.to_string());
                            }
                        }
                    }
                }
                Ok::<_, AppError>((found, stopped))
            }
        })
        .buffered(LIST_CONCURRENCY);
    tokio::pin!(checks);
    let mut existing = HashSet::new();
    let mut truncated = false;
    while let Some(r) = checks.next().await {
        let (found, stopped) = r?;
        truncated |= stopped;
        existing.extend(found);
    }
    Ok((existing, truncated))
}

// ---- working phase: delete --------------------------------------------------------------------

/// The message for a key a `DeleteObjects` response neither confirmed nor reported an error for
/// (and that a `HeadObject` afterwards still found, or could not check).
pub(crate) const DELETE_NOT_CONFIRMED: &str = "The server did not confirm the delete.";

/// What one `DeleteObjects` response says about one requested key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeyOutcome {
    /// Listed under `<Deleted>`.
    Deleted,
    /// Listed under `<Error>` (`"Code: Message"`).
    Failed(String),
    /// In neither list: not proven deleted.
    Unconfirmed,
}

/// Why a `DeleteObjects` batch as a whole has no per-key result.
#[derive(Debug)]
enum BatchError {
    /// The request failed (nothing in it is known to be deleted).
    Request(Box<SdkError<aws_sdk_s3::operation::delete_objects::DeleteObjectsError, HttpResponse>>),
    /// The response cannot be attributed to keys (an `<Error>` without a key).
    Unattributed(String),
}

impl BatchError {
    fn message(self) -> String {
        match self {
            BatchError::Request(e) => AppError::from(*e).message,
            BatchError::Unattributed(m) => m,
        }
    }
}

fn error_text(code: Option<&str>, message: Option<&str>) -> String {
    match (code, message) {
        (Some(c), Some(m)) => format!("{c}: {m}"),
        (Some(c), None) => c.to_string(),
        (None, Some(m)) => m.to_string(),
        (None, None) => "Unknown error".to_string(),
    }
}

/// Classifies a `DeleteObjects` response for the `requested` keys (one outcome per requested
/// key, in order). A key counts as deleted only if the response lists it under `<Deleted>`; an
/// `<Error>` for a key wins over a `<Deleted>` entry for it. An `<Error>` without a key cannot be
/// attributed, so the whole batch fails (no key in it is counted as deleted).
pub(crate) fn classify_delete(
    requested: &[&str],
    deleted: &[Option<&str>],
    errors: &[(Option<&str>, String)],
) -> Result<Vec<KeyOutcome>, String> {
    if let Some((_, m)) = errors.iter().find(|(k, _)| k.is_none_or(str::is_empty)) {
        return Err(format!(
            "The server reported an error without naming the object ({m}), so no object in this batch of {} can be confirmed as deleted.",
            requested.len()
        ));
    }
    let mut failed: HashMap<&str, &str> = HashMap::new();
    for (k, m) in errors {
        if let Some(k) = k {
            failed.entry(k).or_insert(m.as_str());
        }
    }
    let ok: HashSet<&str> = deleted.iter().flatten().copied().collect();
    Ok(requested
        .iter()
        .map(|k| match failed.get(k) {
            Some(m) => KeyOutcome::Failed(m.to_string()),
            None if ok.contains(k) => KeyOutcome::Deleted,
            None => KeyOutcome::Unconfirmed,
        })
        .collect())
}

/// One `DeleteObjects` request (Quiet off), one outcome per key (never `Unconfirmed`: a key the
/// response does not mention is looked up with `HeadObject`; gone = deleted, otherwise it fails
/// with [`DELETE_NOT_CONFIRMED`]). With ETags, each key is deleted only if it still has that ETag.
async fn delete_objects(client: &Client, bucket: &str, keys: &[(&str, Option<&str>)]) -> Result<Vec<KeyOutcome>, BatchError> {
    let ids = keys
        .iter()
        .map(|(k, etag)| ObjectIdentifier::builder().key(*k).set_e_tag(etag.map(str::to_string)).build())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| BatchError::Request(Box::new(SdkError::construction_failure(e))))?;
    let delete = Delete::builder()
        .set_objects(Some(ids))
        .quiet(false)
        .build()
        .map_err(|e| BatchError::Request(Box::new(SdkError::construction_failure(e))))?;
    let resp = client
        .delete_objects()
        .bucket(bucket)
        .delete(delete)
        .send()
        .await
        .map_err(|e| BatchError::Request(Box::new(e)))?;
    let requested: Vec<&str> = keys.iter().map(|(k, _)| *k).collect();
    let deleted: Vec<Option<&str>> = resp.deleted().iter().map(|d| d.key()).collect();
    let errors: Vec<(Option<&str>, String)> =
        resp.errors().iter().map(|e| (e.key(), error_text(e.code(), e.message()))).collect();
    let outcomes = classify_delete(&requested, &deleted, &errors).map_err(BatchError::Unattributed)?;
    // Rare (a server that leaves keys out of the response): confirm each one by looking it up.
    // Index-based (see `expand`): closures taking references trip a compiler limitation.
    let confirm = CancellationToken::new();
    let (confirm, outcomes, requested) = (&confirm, &outcomes, &requested);
    let confirmed: Vec<KeyOutcome> = stream::iter(0..outcomes.len())
        .map(move |i| async move {
            match &outcomes[i] {
                KeyOutcome::Unconfirmed => match head(client, bucket, requested[i], confirm).await {
                    Ok(None) => KeyOutcome::Deleted,
                    Ok(Some(_)) => KeyOutcome::Failed(DELETE_NOT_CONFIRMED.into()),
                    Err(e) => KeyOutcome::Failed(format!("{DELETE_NOT_CONFIRMED} Checking it failed: {}", e.message)),
                },
                o => o.clone(),
            }
        })
        .buffered(LIST_CONCURRENCY)
        .collect()
        .await;
    Ok(confirmed)
}

/// Records the result of one delete-job batch: only confirmed keys count as done.
pub(crate) fn record_delete_batch(entry: &JobEntry, chunk: &[Planned], r: Result<Vec<KeyOutcome>, String>) {
    match r {
        Ok(outcomes) => {
            for (p, o) in chunk.iter().zip(outcomes) {
                match o {
                    KeyOutcome::Deleted => entry.done(p.size),
                    KeyOutcome::Failed(m) => entry.fail(&p.src, m),
                    KeyOutcome::Unconfirmed => entry.fail(&p.src, DELETE_NOT_CONFIRMED.into()),
                }
            }
        }
        Err(m) => {
            for p in chunk {
                entry.fail(&p.src, m.clone());
            }
        }
    }
}

pub(crate) async fn run_delete(ctx: &Ctx<'_>, entry: &JobEntry, work: &[Planned]) {
    let results = stream::iter(0..work.len().div_ceil(DELETE_BATCH))
        .take_until(ctx.cancel.cancelled())
        .map(move |c| async move {
            let chunk = &work[c * DELETE_BATCH..((c + 1) * DELETE_BATCH).min(work.len())];
            let keys: Vec<(&str, Option<&str>)> = chunk.iter().map(|p| (p.src.as_str(), None)).collect();
            (chunk, delete_objects(ctx.src, &ctx.req.src_bucket, &keys).await.map_err(BatchError::message))
        })
        .buffer_unordered(DELETE_CONCURRENCY);
    tokio::pin!(results);
    while let Some((chunk, r)) = results.next().await {
        record_delete_batch(entry, chunk, r);
    }
}

// ---- working phase: copy / move ---------------------------------------------------------------

#[derive(Debug)]
enum Outcome {
    Copied,
    Skipped,
    Failed(String),
    /// Stopped by cancel before anything was written (multipart copy aborted).
    Cancelled,
}

/// Per-job switches learned from the server.
struct Caps {
    /// Send `If-None-Match: *` on copies with `onConflict: skip` (cleared if the server says it
    /// does not implement it).
    if_none_match: AtomicBool,
    /// Send the copied ETag with each move-source delete (cleared if the server rejects it).
    delete_etag: AtomicBool,
}

fn archived_message(p: &Planned) -> String {
    format!(
        "InvalidObjectState: The object is archived ({}) and must be restored before it can be copied.",
        p.storage_class.as_deref().unwrap_or("archive storage class")
    )
}

const SOURCE_CHANGED: &str =
    "PreconditionFailed: The source object changed after it was listed, so it was not copied. Run the operation again to copy the current version.";
const SOURCE_GONE: &str = "NoSuchKey: The source object no longer exists.";

/// What a 412 on a copy means: with `If-None-Match: *` the destination may have appeared since
/// the listing (then the object is skipped); otherwise the source changed (`If-Match` failed).
async fn precondition_outcome(ctx: &Ctx<'_>, p: &Planned, sent_if_none_match: bool) -> Outcome {
    if sent_if_none_match {
        if let (Ok(dest), Some(d)) = (ctx.dest_client(), p.dest.as_deref()) {
            if let Ok(Some(_)) = head(dest, ctx.dest_bucket(), d, &CancellationToken::new()).await {
                return Outcome::Skipped;
            }
        }
    }
    Outcome::Failed(SOURCE_CHANGED.into())
}

fn service_failure<E>(p: &Planned, e: SdkError<E, HttpResponse>) -> String
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
{
    let (status, code) = err_info(&e);
    match code.as_deref() {
        Some("InvalidObjectState") => archived_message(p),
        Some("NoSuchKey") => SOURCE_GONE.into(),
        _ if status == Some(404) && code.is_none() => SOURCE_GONE.into(),
        _ => AppError::from(e).message,
    }
}

fn is_not_implemented(status: Option<u16>, code: Option<&str>) -> bool {
    status == Some(501) || code == Some("NotImplemented")
}

async fn copy_simple(ctx: &Ctx<'_>, caps: &Caps, p: &Planned, dest_key: &str) -> Outcome {
    let Ok(dest) = ctx.dest_client() else { return Outcome::Failed("No destination bucket".into()) };
    let skip = ctx.req.on_conflict == ConflictPolicy::Skip;
    loop {
        let use_inm = skip && caps.if_none_match.load(Ordering::Relaxed);
        let mut r = dest
            .copy_object()
            .bucket(ctx.dest_bucket())
            .key(dest_key)
            .copy_source(encode_copy_source(&ctx.req.src_bucket, &p.src))
            .metadata_directive(MetadataDirective::Copy)
            .set_copy_source_if_match(p.etag.clone())
            .set_storage_class(p.storage_class.as_deref().map(StorageClass::from));
        if use_inm {
            r = r.if_none_match("*");
        }
        // Not cancellable: a copy in flight is allowed to finish, so a cancelled move never
        // leaves a written destination whose source is then kept unknowingly.
        return match r.customize().config_override(copy_timeout(p.size)).send().await {
            Ok(out) if out.copy_object_result().and_then(|c| c.e_tag()).is_some() => Outcome::Copied,
            Ok(_) => Outcome::Failed("The server did not confirm the copy (no ETag in the response).".into()),
            Err(e) => {
                let (status, code) = err_info(&e);
                if use_inm && is_not_implemented(status, code.as_deref()) {
                    caps.if_none_match.store(false, Ordering::Relaxed);
                    continue;
                }
                if status == Some(412) || code.as_deref() == Some("PreconditionFailed") {
                    precondition_outcome(ctx, p, use_inm).await
                } else if is_marker(p) && (code.as_deref() == Some("NoSuchKey") || status == Some(404)) {
                    copy_marker(ctx, caps, p, dest_key).await.unwrap_or_else(|| Outcome::Failed(service_failure(p, e)))
                } else {
                    Outcome::Failed(service_failure(p, e))
                }
            }
        };
    }
}

/// A zero-byte "folder marker" key (ends in `/`).
fn is_marker(p: &Planned) -> bool {
    p.size == 0 && p.src.ends_with('/')
}

/// Some S3-compatible servers (SeaweedFS) store folder markers as directories and answer
/// `CopyObject` on them with NoSuchKey. If a conditional `HeadObject` confirms the marker is
/// still there (same ETag, zero bytes), write an empty object with the same content type and
/// metadata instead. `None` = the marker really is gone (report the original error).
async fn copy_marker(ctx: &Ctx<'_>, caps: &Caps, p: &Planned, dest_key: &str) -> Option<Outcome> {
    let dest = ctx.dest_client().ok()?;
    let h = ctx.src.head_object().bucket(&ctx.req.src_bucket).key(&p.src).set_if_match(p.etag.clone()).send().await.ok()?;
    if h.content_length().unwrap_or(-1) != 0 {
        return None;
    }
    let skip = ctx.req.on_conflict == ConflictPolicy::Skip;
    loop {
        let use_inm = skip && caps.if_none_match.load(Ordering::Relaxed);
        let mut r = dest
            .put_object()
            .bucket(ctx.dest_bucket())
            .key(dest_key)
            .content_length(0)
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b""))
            .set_content_type(h.content_type().map(str::to_string))
            .set_metadata(h.metadata().cloned())
            .set_storage_class(h.storage_class().cloned().or_else(|| p.storage_class.as_deref().map(StorageClass::from)));
        if use_inm {
            r = r.if_none_match("*");
        }
        return Some(match r.send().await {
            Ok(out) if out.e_tag().is_some() => Outcome::Copied,
            Ok(_) => Outcome::Failed("The server did not confirm the copy (no ETag in the response).".into()),
            Err(e) => {
                let (status, code) = err_info(&e);
                if use_inm && is_not_implemented(status, code.as_deref()) {
                    caps.if_none_match.store(false, Ordering::Relaxed);
                    continue;
                }
                if status == Some(412) || code.as_deref() == Some("PreconditionFailed") {
                    // Directory-based servers create the destination "folder" implicitly as
                    // soon as anything is written under it. An empty marker that is already
                    // there is exactly what this copy would have produced.
                    match head(dest, ctx.dest_bucket(), dest_key, &CancellationToken::new()).await {
                        Ok(Some(d)) if d.size == 0 => Outcome::Copied,
                        _ => precondition_outcome(ctx, p, use_inm).await,
                    }
                } else {
                    Outcome::Failed(AppError::from(e).message)
                }
            }
        });
    }
}

/// Query-string encoding of object tags for `CreateMultipartUpload`'s `x-amz-tagging`.
fn tagging_query(tags: &[(String, String)]) -> String {
    let enc = |s: &str| -> String {
        let mut out = String::new();
        for &b in s.as_bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    };
    tags.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

/// Multipart copy for objects above the `CopyObject` limit. Carries over content type and the
/// other content headers, user metadata, storage class and (best effort) tags. The upload is
/// aborted on any failure or cancel.
async fn copy_multipart(ctx: &Ctx<'_>, caps: &Caps, p: &Planned, dest_key: &str) -> Outcome {
    let Ok(dest) = ctx.dest_client() else { return Outcome::Failed("No destination bucket".into()) };
    let dest_bucket = ctx.dest_bucket();
    let src_bucket = &ctx.req.src_bucket;
    if ctx.cancel.is_cancelled() {
        return Outcome::Cancelled;
    }
    let h = match ctx.src.head_object().bucket(src_bucket).key(&p.src).set_if_match(p.etag.clone()).send().await {
        Ok(h) => h,
        Err(e) => {
            let (status, code) = err_info(&e);
            if status == Some(412) || code.as_deref() == Some("PreconditionFailed") {
                return Outcome::Failed(SOURCE_CHANGED.into());
            }
            return Outcome::Failed(service_failure(p, e));
        }
    };
    if h.content_length().unwrap_or(-1) != p.size as i64 {
        return Outcome::Failed(SOURCE_CHANGED.into());
    }
    let Some(etag) = h.e_tag().map(str::to_string).or_else(|| p.etag.clone()) else {
        return Outcome::Failed("The source has no ETag, so a multipart copy cannot be verified.".into());
    };
    let ranges = match plan_copy_parts(p.size, ctx.tuning.part_size) {
        Ok(r) => r,
        Err(m) => return Outcome::Failed(m),
    };
    // Tags are not carried over by UploadPartCopy; copy them explicitly (best effort: servers
    // without tagging support still get the data copied).
    let tags: Vec<(String, String)> = match ctx.src.get_object_tagging().bucket(src_bucket).key(&p.src).send().await {
        Ok(t) => t.tag_set().iter().map(|t| (t.key().to_string(), t.value().to_string())).collect(),
        Err(_) => Vec::new(),
    };
    let storage_class = h.storage_class().cloned().or_else(|| p.storage_class.as_deref().map(StorageClass::from));
    let mut create = dest
        .create_multipart_upload()
        .bucket(dest_bucket)
        .key(dest_key)
        .set_content_type(h.content_type().map(str::to_string))
        .set_content_encoding(h.content_encoding().map(str::to_string))
        .set_content_disposition(h.content_disposition().map(str::to_string))
        .set_content_language(h.content_language().map(str::to_string))
        .set_cache_control(h.cache_control().map(str::to_string))
        .set_metadata(h.metadata().cloned())
        .set_storage_class(storage_class);
    if !tags.is_empty() {
        create = create.tagging(tagging_query(&tags));
    }
    if ctx.cancel.is_cancelled() {
        return Outcome::Cancelled;
    }
    // Not cancellable: dropping it could leave an upload id we never learn about.
    let upload_id = match create.send().await {
        Ok(c) => match c.upload_id() {
            Some(id) => id.to_string(),
            None => return Outcome::Failed("The server returned no upload id".into()),
        },
        Err(e) => return Outcome::Failed(AppError::from(e).message),
    };
    // Aborts the upload on every failure path, and also if this future is dropped or panics.
    let mut guard = AbortOnDrop::new(dest, dest_bucket, dest_key, &upload_id);
    let source = encode_copy_source(src_bucket, &p.src);
    let (source, etag, upload_id, ranges) = (&source, &etag, &upload_id, &ranges);
    let parts: Result<Vec<CompletedPart>, Outcome> = stream::iter(0..ranges.len())
        .map(move |i| {
            let (a, b) = ranges[i];
            async move {
                let n = i as i32 + 1;
                let fut = dest
                    .upload_part_copy()
                    .bucket(dest_bucket)
                    .key(dest_key)
                    .upload_id(upload_id)
                    .part_number(n)
                    .copy_source(source)
                    .copy_source_range(format!("bytes={a}-{b}"))
                    .copy_source_if_match(etag)
                    .customize()
                    .config_override(copy_timeout(b - a + 1))
                    .send();
                match cancellable(ctx.cancel, fut).await {
                    Err(_) => Err(Outcome::Cancelled),
                    Ok(Ok(out)) => match out.copy_part_result().and_then(|r| r.e_tag()) {
                        Some(t) => Ok(CompletedPart::builder().part_number(n).e_tag(t).build()),
                        None => Err(Outcome::Failed(format!("Part {n}: the server did not confirm the copy"))),
                    },
                    Ok(Err(e)) => {
                        let (status, code) = err_info(&e);
                        if status == Some(412) || code.as_deref() == Some("PreconditionFailed") {
                            Err(Outcome::Failed(SOURCE_CHANGED.into()))
                        } else {
                            Err(Outcome::Failed(format!("Part {n}: {}", service_failure(p, e))))
                        }
                    }
                }
            }
        })
        .buffered(PART_CONCURRENCY)
        .try_collect()
        .await;
    let parts = match parts {
        Ok(parts) => parts,
        Err(o) => {
            guard.abort().await;
            return o;
        }
    };
    let skip = ctx.req.on_conflict == ConflictPolicy::Skip;
    loop {
        let use_inm = skip && caps.if_none_match.load(Ordering::Relaxed);
        let mut complete = dest
            .complete_multipart_upload()
            .bucket(dest_bucket)
            .key(dest_key)
            .upload_id(upload_id)
            .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts.clone())).build());
        if use_inm {
            complete = complete.if_none_match("*");
        }
        // Not cancellable (see CreateMultipartUpload).
        return match complete.customize().config_override(copy_timeout(p.size)).send().await {
            Ok(out) if out.e_tag().is_some() => {
                guard.disarm();
                Outcome::Copied
            }
            Ok(_) => {
                guard.abort().await;
                Outcome::Failed("The server did not confirm the multipart copy (no ETag).".into())
            }
            Err(e) => {
                let (status, code) = err_info(&e);
                if use_inm && is_not_implemented(status, code.as_deref()) {
                    caps.if_none_match.store(false, Ordering::Relaxed);
                    continue;
                }
                guard.abort().await;
                if status == Some(412) || code.as_deref() == Some("PreconditionFailed") {
                    precondition_outcome(ctx, p, use_inm).await
                } else {
                    Outcome::Failed(AppError::from(e).message)
                }
            }
        };
    }
}

/// Copies one object (skipping it if it existed at listing time and the policy is skip). For a
/// move the destination's size is checked before the source may be deleted.
async fn copy_one(ctx: &Ctx<'_>, caps: &Caps, p: &Planned, existing: &HashSet<String>) -> Outcome {
    let Some(dest_key) = p.dest.as_deref() else { return Outcome::Failed("No destination".into()) };
    if ctx.req.on_conflict == ConflictPolicy::Skip && existing.contains(dest_key) {
        return Outcome::Skipped;
    }
    let outcome = if p.size > ctx.tuning.multipart_threshold {
        copy_multipart(ctx, caps, p, dest_key).await
    } else {
        copy_simple(ctx, caps, p, dest_key).await
    };
    if !matches!(outcome, Outcome::Copied) || ctx.req.kind != JobKind::Move {
        return outcome;
    }
    let Ok(dest) = ctx.dest_client() else { return Outcome::Failed("No destination bucket".into()) };
    match head(dest, ctx.dest_bucket(), dest_key, &CancellationToken::new()).await {
        Ok(Some(d)) if d.size == p.size => Outcome::Copied,
        Ok(Some(d)) => Outcome::Failed(format!(
            "The copy at {dest_key:?} has {} bytes, expected {}; the original was kept.",
            d.size, p.size
        )),
        Ok(None) => Outcome::Failed(format!("The copy at {dest_key:?} could not be found afterwards; the original was kept.")),
        Err(e) => Outcome::Failed(format!("Could not verify the copy at {dest_key:?} ({}); the original was kept.", e.message)),
    }
}

/// What a move does with one source after a `DeleteObjects` answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SourceStep {
    Deleted,
    /// The server rejected the ETag condition: send this key again without it.
    RetryWithoutEtag,
    Failed(String),
}

pub(crate) fn source_step(with_etag: bool, o: KeyOutcome) -> SourceStep {
    match o {
        KeyOutcome::Deleted => SourceStep::Deleted,
        KeyOutcome::Failed(m) if with_etag && m.starts_with("NotImplemented") => SourceStep::RetryWithoutEtag,
        KeyOutcome::Failed(m) if m.starts_with("PreconditionFailed") => {
            SourceStep::Failed(format!("{m} (the original changed after it was copied)"))
        }
        KeyOutcome::Failed(m) => SourceStep::Failed(m),
        KeyOutcome::Unconfirmed => SourceStep::Failed(DELETE_NOT_CONFIRMED.into()),
    }
}

/// Deletes move sources whose copies are confirmed. Each key is deleted only if it still has
/// the ETag that was copied (when the server supports conditional deletes). If the server
/// rejects the ETag condition itself (the whole request, or per key with NotImplemented), the
/// affected keys are retried once without it; keys that were already deleted are never re-sent.
/// A source counts as moved only when the server confirms its delete (see [`delete_objects`]).
async fn delete_sources<'p>(ctx: &Ctx<'_>, caps: &Caps, batch: Vec<&'p Planned>) -> Vec<(&'p Planned, Result<(), String>)> {
    if let Some(hook) = &ctx.tuning.before_source_delete {
        hook(String::new()).await;
    }
    let mut out = Vec::with_capacity(batch.len());
    let mut todo = batch;
    loop {
        let with_etag = caps.delete_etag.load(Ordering::Relaxed);
        let keys: Vec<(&str, Option<&str>)> = todo
            .iter()
            .map(|p| (p.src.as_str(), if with_etag { p.etag.as_deref() } else { None }))
            .collect();
        match delete_objects(ctx.src, &ctx.req.src_bucket, &keys).await {
            Ok(outcomes) => {
                let mut retry = Vec::new();
                for (p, o) in todo.into_iter().zip(outcomes) {
                    match source_step(with_etag, o) {
                        SourceStep::Deleted => out.push((p, Ok(()))),
                        SourceStep::RetryWithoutEtag => retry.push(p),
                        SourceStep::Failed(m) => out.push((p, Err(m))),
                    }
                }
                if retry.is_empty() {
                    return out;
                }
                caps.delete_etag.store(false, Ordering::Relaxed);
                todo = retry;
            }
            Err(BatchError::Request(e)) => {
                let (status, code) = err_info(&e);
                let unsupported = matches!(status, Some(400) | Some(501))
                    && matches!(
                        code.as_deref(),
                        Some("NotImplemented") | Some("MalformedXML") | Some("InvalidArgument") | Some("InvalidRequest")
                    );
                if with_etag && unsupported {
                    // Nothing in this request was deleted; retry it without conditions.
                    caps.delete_etag.store(false, Ordering::Relaxed);
                    continue;
                }
                let m = AppError::from(*e).message;
                out.extend(todo.into_iter().map(|p| (p, Err(m.clone()))));
                return out;
            }
            Err(BatchError::Unattributed(m)) => {
                out.extend(todo.into_iter().map(|p| (p, Err(m.clone()))));
                return out;
            }
        }
    }
}

pub(crate) fn record_source_delete(entry: &JobEntry, results: Vec<(&Planned, Result<(), String>)>) {
    for (p, r) in results {
        match r {
            Ok(()) => entry.done(p.size),
            Err(m) => entry.fail(
                &p.src,
                format!(
                    "Copied to {:?}, but the original could not be deleted: {}. The copy exists and the original remains.",
                    p.dest.as_deref().unwrap_or_default(),
                    m.trim_end_matches('.')
                ),
            ),
        }
    }
}

/// Copy or move every planned object, up to [`OBJECT_CONCURRENCY`] at a time. On cancel no new
/// copy starts; copies in flight finish (multipart copies stop between parts and are aborted)
/// and the sources of every confirmed copy are still deleted, so each object of a cancelled
/// move is in exactly one place.
pub(crate) async fn run_transfer(ctx: &Ctx<'_>, entry: &JobEntry, work: &[Planned], existing: &HashSet<String>) {
    let is_move = ctx.req.kind == JobKind::Move;
    // Last line of defense: within one bucket, never delete a key this job writes.
    let written: HashSet<&str> = if is_move && ctx.same_bucket() {
        work.iter().filter_map(|p| p.dest.as_deref()).collect()
    } else {
        HashSet::new()
    };
    let caps = Caps { if_none_match: AtomicBool::new(true), delete_etag: AtomicBool::new(true) };
    let caps = &caps;
    let copies = stream::iter(0..work.len())
        .take_until(ctx.cancel.cancelled())
        .map(move |i| async move { (&work[i], copy_one(ctx, caps, &work[i], existing).await) })
        .buffer_unordered(OBJECT_CONCURRENCY);
    tokio::pin!(copies);
    let mut pending: Vec<&Planned> = Vec::new();
    let mut deletes = FuturesUnordered::new();
    let mut tick = tokio::time::interval(SOURCE_DELETE_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            r = copies.next() => {
                let Some((p, outcome)) = r else { break };
                match outcome {
                    Outcome::Copied if is_move => {
                        if written.contains(p.src.as_str()) {
                            entry.fail(&p.src, "Internal safety check: this key is also a destination of the job, so it was not deleted.".to_string());
                        } else {
                            pending.push(p);
                            if pending.len() >= DELETE_BATCH {
                                deletes.push(delete_sources(ctx, caps, std::mem::take(&mut pending)));
                            }
                        }
                    }
                    Outcome::Copied => entry.done(p.size),
                    Outcome::Skipped => entry.skipped(),
                    Outcome::Failed(m) => entry.fail(&p.src, m),
                    Outcome::Cancelled => {}
                }
            }
            Some(res) = deletes.next(), if !deletes.is_empty() => record_source_delete(entry, res),
            _ = tick.tick() => {
                if !pending.is_empty() {
                    deletes.push(delete_sources(ctx, caps, std::mem::take(&mut pending)));
                }
            }
        }
    }
    if !pending.is_empty() {
        deletes.push(delete_sources(ctx, caps, pending));
    }
    while let Some(res) = deletes.next().await {
        record_source_delete(entry, res);
    }
}

// ---- working phase: tag ------------------------------------------------------------------------

/// Job-level error when the server does not implement object tagging (the job stops instead of
/// sending the same refused request for every object).
pub(crate) fn tags_not_supported(e: &AppError) -> AppError {
    AppError::new(ErrorCode::NotSupported, format!("Stopped: {}", e.message))
}

/// Bulk tag edit: each object gets `GetObjectTagging` (merge only), then `PutObjectTagging`, or
/// `DeleteObjectTagging` when the result is empty (see [`crate::tags::tag_object`]). Up to
/// [`OBJECT_CONCURRENCY`] objects in flight; cancel stops new work and lets requests in flight
/// finish. A merge over the object limit, or an object that is gone, is a per-object failure and
/// that object is left as it was. A server that does not implement object tagging stops the job
/// with a job-level `NotSupported` error.
pub(crate) async fn run_tag(ctx: &Ctx<'_>, entry: &JobEntry, work: &[Planned]) -> AppResult<()> {
    let op = ctx.req.tags.as_ref().ok_or_else(|| AppError::invalid("tags is required for tag"))?;
    let stop = ctx.cancel.child_token();
    let results = stream::iter(0..work.len())
        .take_until(stop.clone().cancelled_owned())
        .map(move |i| async move {
            let p = &work[i];
            (p, crate::tags::tag_object(ctx.src, &ctx.req.src_bucket, &p.src, op).await)
        })
        .buffer_unordered(OBJECT_CONCURRENCY);
    tokio::pin!(results);
    let mut unsupported: Option<AppError> = None;
    while let Some((p, r)) = results.next().await {
        match r {
            Ok(()) => entry.done(0),
            Err(e) => {
                if e.code == ErrorCode::NotSupported && unsupported.is_none() {
                    unsupported = Some(tags_not_supported(&e));
                    stop.cancel();
                }
                entry.fail(&p.src, e.message);
            }
        }
    }
    match unsupported {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{now_iso, Job, JobPhase, JobStatus};

    fn entry(total: u64) -> JobEntry {
        let job = Job {
            id: "j".into(),
            kind: JobKind::Delete,
            src_bucket: "b".into(),
            dest_bucket: None,
            label: String::new(),
            phase: JobPhase::Working,
            total_items: total,
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
        };
        JobEntry::new(0, job)
    }

    fn planned(src: &str, dest: Option<&str>, etag: Option<&str>) -> Planned {
        Planned {
            src: src.into(),
            dest: dest.map(Into::into),
            size: 10,
            etag: etag.map(Into::into),
            storage_class: None,
            item: 0,
        }
    }

    use KeyOutcome::{Deleted, Failed, Unconfirmed};

    #[test]
    fn delete_response_classification() {
        let req = ["a", "b", "c"];
        // All confirmed.
        assert_eq!(classify_delete(&req, &[Some("a"), Some("b"), Some("c")], &[]), Ok(vec![Deleted, Deleted, Deleted]));
        // One in neither list: not counted as deleted (it used to be).
        assert_eq!(classify_delete(&req, &[Some("a"), Some("c")], &[]), Ok(vec![Deleted, Unconfirmed, Deleted]));
        // An empty response confirms nothing (e.g. a server that answered as if Quiet were on).
        assert_eq!(classify_delete(&req, &[], &[]), Ok(vec![Unconfirmed, Unconfirmed, Unconfirmed]));
        // An error with a key fails that key only.
        assert_eq!(
            classify_delete(&req, &[Some("a"), Some("c")], &[(Some("b"), "AccessDenied: no".into())]),
            Ok(vec![Deleted, Failed("AccessDenied: no".into()), Deleted])
        );
        // An error without a key (missing or empty) fails the whole batch.
        for k in [None, Some("")] {
            let e = classify_delete(&req, &[Some("a"), Some("b"), Some("c")], &[(k, "InternalError: boom".into())])
                .expect_err("unattributable");
            assert!(e.contains("InternalError: boom") && e.contains("batch of 3"), "{e}");
        }
        // Duplicates: repeated entries are harmless; the first error message for a key wins; an
        // error beats a contradictory Deleted entry; a key requested twice gets the same answer.
        assert_eq!(
            classify_delete(
                &["a", "b", "a"],
                &[Some("a"), Some("a"), Some("b"), None, Some("zzz")],
                &[(Some("b"), "E1: first".into()), (Some("b"), "E2: second".into())]
            ),
            Ok(vec![Deleted, Failed("E1: first".into()), Deleted])
        );
        // Keys are compared byte for byte.
        assert_eq!(classify_delete(&["a/", "A"], &[Some("a"), Some("a/ ")], &[]), Ok(vec![Unconfirmed, Unconfirmed]));
    }

    #[test]
    fn delete_job_counts_only_confirmed_keys() {
        let chunk = [planned("a", None, None), planned("b", None, None), planned("c", None, None)];
        let e = entry(3);
        record_delete_batch(&e, &chunk, Ok(vec![Deleted, Unconfirmed, Failed("AccessDenied: no".into())]));
        let j = e.snapshot();
        assert_eq!((j.done_items, j.failed_items, j.done_bytes), (1, 2, 10));
        assert_eq!(j.errors[0].key, "b");
        assert_eq!(j.errors[0].message, DELETE_NOT_CONFIRMED);
        assert_eq!(j.errors[1].message, "AccessDenied: no");
        // A whole-batch failure counts nothing as done.
        let e = entry(3);
        record_delete_batch(&e, &chunk, Err("unattributable".into()));
        let j = e.snapshot();
        assert_eq!((j.done_items, j.failed_items), (0, 3));
        assert!(j.errors.iter().all(|x| x.message == "unattributable"));
        let mut done = e.snapshot();
        crate::jobs::finish(&mut done, Ok(()), false);
        assert_eq!(done.status, JobStatus::Failed);
    }

    #[test]
    fn move_source_steps() {
        assert_eq!(source_step(true, Deleted), SourceStep::Deleted);
        assert_eq!(source_step(true, Unconfirmed), SourceStep::Failed(DELETE_NOT_CONFIRMED.into()));
        assert_eq!(source_step(false, Unconfirmed), SourceStep::Failed(DELETE_NOT_CONFIRMED.into()));
        // The ETag condition was rejected: retried once without it (only while it was sent).
        assert_eq!(source_step(true, Failed("NotImplemented: x".into())), SourceStep::RetryWithoutEtag);
        assert_eq!(source_step(false, Failed("NotImplemented: x".into())), SourceStep::Failed("NotImplemented: x".into()));
        match source_step(true, Failed("PreconditionFailed: x".into())) {
            SourceStep::Failed(m) => assert!(m.contains("changed after it was copied"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn move_accounting_never_counts_an_unconfirmed_source() {
        let a = planned("s/a", Some("d/a"), Some("e"));
        let b = planned("s/b", Some("d/b"), Some("e"));
        let e = entry(2);
        let steps = [source_step(true, Deleted), source_step(true, Unconfirmed)];
        let results: Vec<(&Planned, Result<(), String>)> = [&a, &b]
            .into_iter()
            .zip(steps)
            .map(|(p, s)| match s {
                SourceStep::Deleted => (p, Ok(())),
                SourceStep::Failed(m) => (p, Err(m)),
                SourceStep::RetryWithoutEtag => unreachable!(),
            })
            .collect();
        record_source_delete(&e, results);
        let j = e.snapshot();
        assert_eq!((j.done_items, j.failed_items), (1, 1));
        let m = &j.errors[0].message;
        assert_eq!(j.errors[0].key, "s/b");
        assert!(m.contains("did not confirm the delete"), "{m}");
        assert!(m.contains("The copy exists and the original remains."), "{m}");
        assert!(m.contains("d/b"), "{m}");
        assert!(!m.contains(".."), "no doubled period: {m}");
    }

    #[test]
    fn moves_need_an_etag_copies_do_not() {
        let work = vec![planned("a", Some("x/a"), Some("1")), planned("b", Some("x/b"), None), planned("c", Some("x/c"), Some(""))];
        let (ok, errs) = split_unmovable(JobKind::Copy, work.clone());
        assert_eq!(ok.len(), 3);
        assert!(errs.is_empty());
        let (ok, errs) = split_unmovable(JobKind::Move, work);
        assert_eq!(ok.iter().map(|p| p.src.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(errs.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
        assert!(errs.iter().all(|e| e.message == NO_ETAG_FOR_MOVE));
    }

    #[test]
    fn copy_timeout_scales_with_size() {
        let mib = 1024 * 1024;
        assert_eq!(copy_timeout_for(0), COPY_TIMEOUT_MIN);
        assert_eq!(copy_timeout_for(256 * mib), COPY_TIMEOUT_MIN, "small copies keep the old 15 min");
        // A 5 GiB CopyObject (or UploadPartCopy part) at 2 MiB/s takes 2,560 s > 15 min.
        let five_gib = 5 * 1024 * mib;
        assert_eq!(copy_timeout_for(five_gib), Duration::from_secs(300 + 2560));
        assert!(copy_timeout_for(five_gib) > Duration::from_secs(five_gib / COPY_MIN_RATE));
        assert_eq!(copy_timeout_for(u64::MAX), COPY_TIMEOUT_MAX);
    }

    #[test]
    fn tagging_is_query_encoded() {
        let t = vec![("a b".to_string(), "x&y=z".to_string()), ("ü".to_string(), "".to_string())];
        assert_eq!(tagging_query(&t), "a%20b=x%26y%3Dz&%C3%BC=");
        assert_eq!(tagging_query(&[]), "");
    }

    #[test]
    fn not_implemented_detection() {
        assert!(is_not_implemented(Some(501), None));
        assert!(is_not_implemented(Some(400), Some("NotImplemented")));
        assert!(!is_not_implemented(Some(412), Some("PreconditionFailed")));
    }
}
