//! Archived objects (`GLACIER`, `DEEP_ARCHIVE`, Intelligent-Tiering archive tiers): reading the
//! restore state from `x-amz-restore`, validating restore requests and `RestoreObject`.
//!
//! No Tauri types here; the single-object command and the `restore` job kind both use it.

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::types::{GlacierJobParameters, Tier};
use aws_sdk_s3::Client;
use chrono::{DateTime, Utc};

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{RestoreRequest, RestoreStatus, RestoreTier, RESTORE_DAYS_MAX, RESTORE_DAYS_MIN};

pub const GLACIER: &str = "GLACIER";
pub const DEEP_ARCHIVE: &str = "DEEP_ARCHIVE";
pub const INTELLIGENT_TIERING: &str = "INTELLIGENT_TIERING";

/// Storage classes whose objects always need a restore before they can be read
/// (`ARCHIVE_STORAGE_CLASSES` in `types.ts`).
pub fn is_archive_class(storage_class: Option<&str>) -> bool {
    matches!(storage_class, Some(GLACIER) | Some(DEEP_ARCHIVE))
}

/// Parses `x-amz-restore`: `ongoing-request="true"` (in progress) or
/// `ongoing-request="false", expiry-date="Fri, 21 Dec 2012 00:00:00 GMT"` (restored until then).
/// Tolerates odd spacing, key case and unquoted values. The expiry becomes ISO-8601 UTC; a date
/// that cannot be parsed is passed through as sent. `None` when there is no `ongoing-request`.
pub fn parse_restore_header(header: &str) -> Option<RestoreStatus> {
    let mut ongoing: Option<bool> = None;
    let mut expiry: Option<String> = None;
    for (k, v) in header_pairs(header) {
        match k.to_ascii_lowercase().as_str() {
            "ongoing-request" => ongoing = Some(v.trim().eq_ignore_ascii_case("true")),
            "expiry-date" => expiry = Some(v.trim().to_string()).filter(|v| !v.is_empty()),
            _ => {}
        }
    }
    let in_progress = ongoing?;
    let expires_at = if in_progress { None } else { expiry.map(|e| iso_date(&e)) };
    Some(RestoreStatus { in_progress, expires_at })
}

/// `key="value"` / `key=value` pairs separated by commas; a quoted value may contain commas.
fn header_pairs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = s;
    loop {
        rest = rest.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
        if rest.is_empty() {
            return out;
        }
        let Some(eq) = rest.find('=') else { return out };
        let key = rest[..eq].trim().to_string();
        let after = rest[eq + 1..].trim_start();
        let (value, next) = if let Some(q) = after.strip_prefix('"') {
            match q.find('"') {
                Some(end) => (q[..end].to_string(), &q[end + 1..]),
                None => (q.to_string(), ""),
            }
        } else {
            match after.find(',') {
                Some(end) => (after[..end].to_string(), &after[end..]),
                None => (after.to_string(), ""),
            }
        };
        out.push((key, value));
        rest = next;
    }
}

/// RFC 1123 (`Fri, 21 Dec 2012 00:00:00 GMT`) or RFC 3339 to ISO-8601 UTC with milliseconds.
fn iso_date(s: &str) -> String {
    let parsed = DateTime::parse_from_rfc2822(s).or_else(|_| DateTime::parse_from_rfc3339(s));
    match parsed {
        Ok(d) => d.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        Err(_) => s.to_string(),
    }
}

/// What a `HeadObject` says about an object's archive state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ArchiveInfo {
    /// The storage class (`None` = STANDARD).
    pub storage_class: Option<String>,
    /// `x-amz-archive-status` (Intelligent-Tiering: `ARCHIVE_ACCESS` / `DEEP_ARCHIVE_ACCESS`).
    pub archive_status: Option<String>,
    pub restore: Option<RestoreStatus>,
}

impl ArchiveInfo {
    pub fn from_head(h: &aws_sdk_s3::operation::head_object::HeadObjectOutput) -> Self {
        Self {
            storage_class: h.storage_class().map(|s| s.as_str().to_string()),
            archive_status: h.archive_status().map(|s| s.as_str().to_string()).filter(|s| !s.is_empty()),
            restore: h.restore().and_then(parse_restore_header),
        }
    }

    /// In an archive: GLACIER / DEEP_ARCHIVE, or Intelligent-Tiering in one of its archive tiers.
    pub fn in_archive(&self) -> bool {
        is_archive_class(self.storage_class.as_deref())
            || (self.storage_class.as_deref() == Some(INTELLIGENT_TIERING) && self.archive_status.is_some())
    }

    fn is_deep(&self) -> bool {
        self.storage_class.as_deref() == Some(DEEP_ARCHIVE)
    }

    fn is_intelligent_tiering(&self) -> bool {
        self.storage_class.as_deref() == Some(INTELLIGENT_TIERING)
    }

    /// A finished restore whose copy has not expired yet (`now` decides; an expiry that cannot
    /// be read counts as not expired, because S3 drops the header once the copy expires).
    pub fn restored(&self, now: DateTime<Utc>) -> bool {
        match &self.restore {
            Some(RestoreStatus { in_progress: false, expires_at }) => match expires_at.as_deref() {
                Some(e) => DateTime::parse_from_rfc3339(e).map(|d| d.with_timezone(&Utc) > now).unwrap_or(true),
                None => true,
            },
            _ => false,
        }
    }

    pub fn in_progress(&self) -> bool {
        matches!(self.restore, Some(RestoreStatus { in_progress: true, .. }))
    }

    /// True when the object must be restored before it can be read.
    pub fn archived(&self, now: DateTime<Utc>) -> bool {
        self.in_archive() && !self.restored(now)
    }
}

pub const DAYS_OUT_OF_RANGE: &str = "restore.days must be a whole number from 1 to 365";

/// Days 1..=365 (the tier is checked by deserialization).
pub fn validate_request(req: &RestoreRequest) -> AppResult<()> {
    if !(RESTORE_DAYS_MIN..=RESTORE_DAYS_MAX).contains(&req.days) {
        return Err(AppError::invalid(format!("{DAYS_OUT_OF_RANGE} (got {})", req.days)));
    }
    Ok(())
}

pub const EXPEDITED_DEEP_ARCHIVE: &str =
    "Expedited retrieval is not available for Deep Archive objects. Choose Standard or Bulk.";
pub const EXPEDITED_INTELLIGENT_TIERING: &str =
    "Expedited retrieval is not available for Intelligent-Tiering archive tiers. Choose Standard or Bulk.";

/// Tiers S3 does not offer for this object: Expedited on Deep Archive and on the
/// Intelligent-Tiering archive tiers. `InvalidInput` before any request is sent.
pub fn check_tier(req: &RestoreRequest, info: &ArchiveInfo) -> AppResult<()> {
    if req.tier == RestoreTier::Expedited {
        if info.is_deep() {
            return Err(AppError::invalid(EXPEDITED_DEEP_ARCHIVE));
        }
        if info.is_intelligent_tiering() {
            return Err(AppError::invalid(EXPEDITED_INTELLIGENT_TIERING));
        }
    }
    Ok(())
}

pub const ALREADY_RESTORING: &str = "The object is already being restored.";

pub fn not_archived(key: &str, info: &ArchiveInfo) -> String {
    format!(
        "{key} is not archived (storage class {}), so it can be read without a restore.",
        info.storage_class.as_deref().unwrap_or("STANDARD")
    )
}

/// `HeadObject` for the archive state. Errors carry the key.
pub async fn head_info(client: &Client, bucket: &str, key: &str) -> AppResult<ArchiveInfo> {
    match client.head_object().bucket(bucket).key(key).send().await {
        Ok(h) => Ok(ArchiveInfo::from_head(&h)),
        Err(e) => {
            let e = AppError::from(e);
            Err(AppError::new(e.code, format!("{key}: {}", e.message)))
        }
    }
}

/// `RestoreObject` with `Days` and `GlacierJobParameters { Tier }`. Intelligent-Tiering archive
/// tiers take no `Days` (the object moves back to its frequent-access tier), so it is left out
/// for them. Errors: `RestoreAlreadyInProgress` → `Conflict`, `InvalidObjectState` →
/// `InvalidInput`, a server without RestoreObject → `NotSupported`.
pub async fn send_restore(client: &Client, bucket: &str, key: &str, req: &RestoreRequest, info: &ArchiveInfo) -> AppResult<()> {
    let params = GlacierJobParameters::builder()
        .tier(Tier::from(req.tier.as_str()))
        .build()
        .map_err(|e| AppError::invalid(format!("Invalid restore request: {e}")))?;
    let mut body = aws_sdk_s3::types::RestoreRequest::builder().glacier_job_parameters(params);
    if !info.is_intelligent_tiering() {
        body = body.days(req.days as i32);
    }
    match client.restore_object().bucket(bucket).key(key).restore_request(body.build()).send().await {
        Ok(_) => Ok(()),
        Err(e) => {
            let code = e.as_service_error().and_then(|s| s.code()).map(str::to_string);
            let err = AppError::from(e);
            Err(match code.as_deref() {
                Some("RestoreAlreadyInProgress") => AppError::new(ErrorCode::Conflict, ALREADY_RESTORING),
                // On RestoreObject this means the object is not in an archive storage class.
                Some("InvalidObjectState") => AppError::invalid(format!("{key}: S3 refused the restore because the object is not in an archive storage class.")),
                _ if err.code == ErrorCode::NotSupported => {
                    AppError::new(ErrorCode::NotSupported, format!("This server does not support restoring archived objects ({}).", err.message))
                }
                _ => err,
            })
        }
    }
}

/// `restore_object`: validates, looks the object up, refuses what S3 would refuse (not
/// archived, already restoring, Expedited on Deep Archive), then sends `RestoreObject`. An object
/// that is restored already is sent again: S3 then extends the restored copy to the new `days`.
pub async fn restore_object(client: &Client, bucket: &str, key: &str, req: &RestoreRequest) -> AppResult<()> {
    if key.is_empty() || key.ends_with('/') {
        return Err(AppError::invalid("A file key is required"));
    }
    validate_request(req)?;
    let info = head_info(client, bucket, key).await?;
    if !info.in_archive() {
        return Err(AppError::invalid(not_archived(key, &info)));
    }
    if info.in_progress() {
        return Err(AppError::new(ErrorCode::Conflict, ALREADY_RESTORING));
    }
    check_tier(req, &info)?;
    send_restore(client, bucket, key, req, &info).await
}

/// What a restore job does with one object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobStep {
    /// Not archived, already being restored, or restored and not expired.
    Skip,
    Restore,
    Fail(String),
}

/// The restore job's decision after `HeadObject`.
pub fn job_step(req: &RestoreRequest, info: &ArchiveInfo, now: DateTime<Utc>) -> JobStep {
    if !info.in_archive() || info.in_progress() || info.restored(now) {
        return JobStep::Skip;
    }
    match check_tier(req, info) {
        Ok(()) => JobStep::Restore,
        Err(e) => JobStep::Fail(e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{h, FakeS3, Reply};

    fn info(sc: Option<&str>, status: Option<&str>, restore: Option<&str>) -> ArchiveInfo {
        ArchiveInfo {
            storage_class: sc.map(str::to_string),
            archive_status: status.map(str::to_string),
            restore: restore.and_then(parse_restore_header),
        }
    }
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-06T12:00:00Z").expect("date").with_timezone(&Utc)
    }
    fn rr(tier: RestoreTier, days: i64) -> RestoreRequest {
        RestoreRequest { tier, days }
    }

    #[test]
    fn restore_header_both_forms() {
        assert_eq!(
            parse_restore_header(r#"ongoing-request="true""#),
            Some(RestoreStatus { in_progress: true, expires_at: None })
        );
        assert_eq!(
            parse_restore_header(r#"ongoing-request="false", expiry-date="Fri, 21 Dec 2012 00:00:00 GMT""#),
            Some(RestoreStatus { in_progress: false, expires_at: Some("2012-12-21T00:00:00.000Z".into()) })
        );
    }

    #[test]
    fn restore_header_odd_spacing_case_and_quotes() {
        let done = Some(RestoreStatus { in_progress: false, expires_at: Some("2026-11-01T00:00:00.000Z".into()) });
        assert_eq!(parse_restore_header(r#"  ongoing-request = "false" ,expiry-date= "Sun, 01 Nov 2026 00:00:00 GMT"  "#), done);
        assert_eq!(parse_restore_header(r#"Ongoing-Request="FALSE",Expiry-Date="Sun, 01 Nov 2026 00:00:00 GMT""#), done);
        assert_eq!(parse_restore_header(r#"expiry-date="Sun, 01 Nov 2026 00:00:00 GMT", ongoing-request="false""#), done, "order");
        assert_eq!(parse_restore_header("ongoing-request=true"), Some(RestoreStatus { in_progress: true, expires_at: None }));
        // An expiry on an in-progress restore is ignored; an unreadable date passes through.
        assert_eq!(
            parse_restore_header(r#"ongoing-request="true", expiry-date="Sun, 01 Nov 2026 00:00:00 GMT""#),
            Some(RestoreStatus { in_progress: true, expires_at: None })
        );
        assert_eq!(
            parse_restore_header(r#"ongoing-request="false", expiry-date="soon""#),
            Some(RestoreStatus { in_progress: false, expires_at: Some("soon".into()) })
        );
        assert_eq!(parse_restore_header(r#"ongoing-request="false""#), Some(RestoreStatus { in_progress: false, expires_at: None }));
        assert_eq!(parse_restore_header(""), None);
        assert_eq!(parse_restore_header("garbage"), None);
        assert_eq!(parse_restore_header(r#"expiry-date="Sun, 01 Nov 2026 00:00:00 GMT""#), None);
    }

    #[test]
    fn archived_state() {
        let n = now();
        assert!(!info(None, None, None).archived(n), "standard");
        assert!(!info(Some("STANDARD_IA"), None, None).archived(n));
        assert!(!info(Some("GLACIER_IR"), None, None).archived(n), "instant retrieval needs no restore");
        assert!(info(Some("GLACIER"), None, None).archived(n));
        assert!(info(Some("DEEP_ARCHIVE"), None, None).archived(n));
        assert!(info(Some("GLACIER"), None, Some(r#"ongoing-request="true""#)).archived(n), "still restoring");
        let restored = info(Some("GLACIER"), None, Some(r#"ongoing-request="false", expiry-date="Sun, 01 Nov 2026 00:00:00 GMT""#));
        assert!(!restored.archived(n) && restored.restored(n));
        let expired = info(Some("GLACIER"), None, Some(r#"ongoing-request="false", expiry-date="Mon, 01 Jan 2024 00:00:00 GMT""#));
        assert!(expired.archived(n), "an expired restored copy is archived again");
        assert!(!info(Some("INTELLIGENT_TIERING"), None, None).archived(n), "frequent/infrequent tiers");
        assert!(info(Some("INTELLIGENT_TIERING"), Some("ARCHIVE_ACCESS"), None).archived(n));
        assert!(info(Some("INTELLIGENT_TIERING"), Some("DEEP_ARCHIVE_ACCESS"), None).archived(n));
    }

    #[test]
    fn days_and_tier_validation() {
        assert!(validate_request(&rr(RestoreTier::Bulk, 1)).is_ok());
        assert!(validate_request(&rr(RestoreTier::Standard, 365)).is_ok());
        for d in [0, -1, 366, 10_000] {
            let e = validate_request(&rr(RestoreTier::Bulk, d)).expect_err("out of range");
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.starts_with(DAYS_OUT_OF_RANGE), "{}", e.message);
        }
        let deep = info(Some("DEEP_ARCHIVE"), None, None);
        let glacier = info(Some("GLACIER"), None, None);
        let it = info(Some("INTELLIGENT_TIERING"), Some("ARCHIVE_ACCESS"), None);
        assert_eq!(check_tier(&rr(RestoreTier::Expedited, 1), &deep).expect_err("deep").message, EXPEDITED_DEEP_ARCHIVE);
        assert_eq!(check_tier(&rr(RestoreTier::Expedited, 1), &it).expect_err("it").message, EXPEDITED_INTELLIGENT_TIERING);
        assert!(check_tier(&rr(RestoreTier::Expedited, 1), &glacier).is_ok());
        assert!(check_tier(&rr(RestoreTier::Standard, 1), &deep).is_ok());
        assert!(check_tier(&rr(RestoreTier::Bulk, 1), &deep).is_ok());
        // serde: exactly the S3 names
        assert_eq!(serde_json::to_string(&rr(RestoreTier::Expedited, 7)).expect("json"), r#"{"tier":"Expedited","days":7}"#);
        assert!(serde_json::from_str::<RestoreRequest>(r#"{"tier":"bulk","days":7}"#).is_err());
        assert_eq!(serde_json::from_str::<RestoreRequest>(r#"{"tier":"Bulk","days":7}"#).expect("json"), rr(RestoreTier::Bulk, 7));
    }

    #[test]
    fn job_decisions() {
        let n = now();
        let std = rr(RestoreTier::Standard, 7);
        assert_eq!(job_step(&std, &info(None, None, None), n), JobStep::Skip);
        assert_eq!(job_step(&std, &info(Some("GLACIER"), None, Some(r#"ongoing-request="true""#)), n), JobStep::Skip);
        let restored = info(Some("GLACIER"), None, Some(r#"ongoing-request="false", expiry-date="Sun, 01 Nov 2026 00:00:00 GMT""#));
        assert_eq!(job_step(&std, &restored, n), JobStep::Skip);
        assert_eq!(job_step(&std, &info(Some("GLACIER"), None, None), n), JobStep::Restore);
        assert_eq!(job_step(&std, &info(Some("DEEP_ARCHIVE"), None, None), n), JobStep::Restore);
        assert_eq!(
            job_step(&rr(RestoreTier::Expedited, 7), &info(Some("DEEP_ARCHIVE"), None, None), n),
            JobStep::Fail(EXPEDITED_DEEP_ARCHIVE.into())
        );
    }

    fn head_reply(sc: &str, restore: Option<&str>) -> Reply {
        let mut hs = vec![h("Content-Length", "3"), h("ETag", "\"e\"")];
        if !sc.is_empty() {
            hs.push(h("x-amz-storage-class", sc));
        }
        if let Some(r) = restore {
            hs.push(h("x-amz-restore", r));
        }
        Reply::with_headers(200, hs)
    }

    #[tokio::test]
    async fn head_object_reports_archive_state() {
        let s3 = FakeS3::start(|r| match r.path.as_str() {
            "/b/cold" => head_reply("GLACIER", None),
            "/b/busy" => head_reply("DEEP_ARCHIVE", Some(r#"ongoing-request="true""#)),
            "/b/warm" => head_reply("GLACIER", Some(r#"ongoing-request="false", expiry-date="Fri, 01 Jan 2100 00:00:00 GMT""#)),
            _ => head_reply("", None),
        })
        .await;
        let c = s3.client();
        let m = crate::ops::head_object(&c, "b", "cold").await.expect("head");
        assert!(m.archived && m.restore.is_none());
        let m = crate::ops::head_object(&c, "b", "busy").await.expect("head");
        assert!(m.archived);
        assert_eq!(m.restore, Some(RestoreStatus { in_progress: true, expires_at: None }));
        let m = crate::ops::head_object(&c, "b", "warm").await.expect("head");
        assert!(!m.archived, "a restored copy can be read");
        assert_eq!(m.restore, Some(RestoreStatus { in_progress: false, expires_at: Some("2100-01-01T00:00:00.000Z".into()) }));
        let m = crate::ops::head_object(&c, "b", "plain").await.expect("head");
        assert!(!m.archived && m.restore.is_none());
        let json = serde_json::to_value(&m).expect("json");
        assert_eq!((json["archived"].clone(), json["restore"].clone()), (serde_json::json!(false), serde_json::Value::Null));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reading_an_archived_object_says_restore_it_first() {
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => head_reply("GLACIER", None),
            _ => Reply::xml(403, "<Error><Code>InvalidObjectState</Code><Message>The operation is not valid for the object's storage class</Message></Error>"),
        })
        .await;
        let tm = crate::transfers::TransferManager::new(std::sync::Arc::new(crate::transfers::NoopSink));
        let dir = crate::testutil::ScratchDir::new("archived-dl");
        let id = tm.start_download(s3.client(), "b", "cold", dir.0.join("cold")).expect("start");
        let t = tm.wait(&id).await.expect("known");
        assert_eq!(t.status, crate::models::TransferStatus::Failed);
        assert_eq!(t.error.as_deref(), Some(crate::error::ARCHIVED));
    }

    #[tokio::test]
    async fn restore_object_requests_and_errors() {
        let s3 = FakeS3::start(|r| match (r.method.as_str(), r.path.as_str()) {
            ("HEAD", "/b/plain") => head_reply("", None),
            ("HEAD", "/b/busy") => head_reply("GLACIER", Some(r#"ongoing-request="true""#)),
            ("HEAD", "/b/deep") => head_reply("DEEP_ARCHIVE", None),
            ("HEAD", "/b/it") => head_reply("INTELLIGENT_TIERING", None),
            ("HEAD", _) => head_reply("GLACIER", None),
            ("POST", "/b/race") => Reply::xml(409, "<Error><Code>RestoreAlreadyInProgress</Code><Message>Object restore is already in progress</Message></Error>"),
            ("POST", "/b/state") => Reply::xml(403, "<Error><Code>InvalidObjectState</Code><Message>Restore is not allowed for the object's current storage class</Message></Error>"),
            ("POST", _) => Reply::status(202),
            _ => Reply::status(500),
        })
        .await;
        let c = s3.client();
        let std = rr(RestoreTier::Standard, 7);
        restore_object(&c, "b", "g", &std).await.expect("glacier restore");
        let post = s3.requests().into_iter().find(|r| r.method == "POST").expect("restore request");
        assert!(post.has_query("restore"));
        let body = String::from_utf8_lossy(&post.body).to_string();
        assert!(body.contains("<Days>7</Days>") && body.contains("<Tier>Standard</Tier>"), "{body}");

        let e = restore_object(&c, "b", "plain", &std).await.expect_err("standard");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.contains("is not archived (storage class STANDARD)"), "{}", e.message);
        let e = restore_object(&c, "b", "busy", &std).await.expect_err("in progress");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Conflict, ALREADY_RESTORING));
        let before = s3.count(|r| r.method == "POST");
        let e = restore_object(&c, "b", "deep", &rr(RestoreTier::Expedited, 3)).await.expect_err("expedited deep");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, EXPEDITED_DEEP_ARCHIVE));
        let e = restore_object(&c, "b", "g", &rr(RestoreTier::Bulk, 0)).await.expect_err("days");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert_eq!(s3.count(|r| r.method == "POST"), before, "refused before any RestoreObject");
        let e = restore_object(&c, "b", "race", &std).await.expect_err("race");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Conflict, ALREADY_RESTORING));
        let e = restore_object(&c, "b", "state", &std).await.expect_err("state");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.starts_with("state: S3 refused the restore"), "{}", e.message);

        // Intelligent-Tiering archive tier: no Days element.
        let s3 = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => Reply::with_headers(
                200,
                vec![h("Content-Length", "3"), h("x-amz-storage-class", "INTELLIGENT_TIERING"), h("x-amz-archive-status", "ARCHIVE_ACCESS")],
            ),
            _ => Reply::status(202),
        })
        .await;
        restore_object(&s3.client(), "b", "it", &std).await.expect("it restore");
        let post = s3.requests().into_iter().find(|r| r.method == "POST").expect("restore request");
        let body = String::from_utf8_lossy(&post.body).to_string();
        assert!(!body.contains("<Days>") && body.contains("<Tier>Standard</Tier>"), "{body}");
    }
}
