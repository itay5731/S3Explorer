//! Wire types. Mirrors `src/lib/types.ts` exactly (camelCase JSON).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
    pub has_credentials: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectionConfig {
    #[serde(rename_all = "camelCase")]
    Profile {
        profile: String,
        #[serde(default)]
        region: Option<String>,
        #[serde(default)]
        endpoint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Static {
        access_key_id: String,
        secret_access_key: String,
        #[serde(default)]
        session_token: Option<String>,
        region: String,
        #[serde(default)]
        endpoint: Option<String>,
        #[serde(default)]
        force_path_style: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub label: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub can_list_buckets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub name: String,
    pub creation_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub prefix: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    pub key: String,
    pub name: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub folders: Vec<FolderEntry>,
    pub objects: Vec<ObjectEntry>,
    pub next_continuation_token: Option<String>,
    pub is_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMeta {
    pub key: String,
    pub name: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    pub content_type: Option<String>,
    pub metadata: HashMap<String, String>,
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteError {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: u64,
    pub errors: Vec<DeleteError>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferKind {
    Download,
    Upload,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TransferStatus {
    pub fn is_active(self) -> bool {
        matches!(self, TransferStatus::Queued | TransferStatus::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub kind: TransferKind,
    pub bucket: String,
    pub key: String,
    pub local_path: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub parts_total: u32,
    pub parts_done: u32,
    pub bytes_per_sec: u64,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

pub const TRANSFER_PROGRESS_EVENT: &str = "transfer:progress";

/// Inclusive limits for [`TransferSettings`] (mirror `TRANSFER_SETTINGS_LIMITS` in `types.ts`).
pub const PART_SIZE_MIB_MIN: u32 = 1;
pub const PART_SIZE_MIB_MAX: u32 = 256;
pub const MAX_CONCURRENT_PARTS_MIN: u32 = 1;
pub const MAX_CONCURRENT_PARTS_MAX: u32 = 32;
pub const MAX_CONCURRENT_TRANSFERS_MIN: u32 = 1;
pub const MAX_CONCURRENT_TRANSFERS_MAX: u32 = 10;
/// Defaults (mirror `DEFAULT_TRANSFER_SETTINGS` in `types.ts`).
pub const DEFAULT_MAX_CONCURRENT_PARTS: u32 = 8;
pub const DEFAULT_MAX_CONCURRENT_TRANSFERS: u32 = 4;

/// User-tunable transfer settings. `part_size_mib: None` means Auto.
///
/// Deserialization is lenient (missing fields take their default, unknown fields are ignored) so
/// the on-disk file stays forward compatible. Range checks are done by [`TransferSettings::validate`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferSettings {
    #[serde(default)]
    pub part_size_mib: Option<u32>,
    #[serde(default = "default_max_concurrent_parts")]
    pub max_concurrent_parts: u32,
    #[serde(default = "default_max_concurrent_transfers")]
    pub max_concurrent_transfers: u32,
}

fn default_max_concurrent_parts() -> u32 {
    DEFAULT_MAX_CONCURRENT_PARTS
}

fn default_max_concurrent_transfers() -> u32 {
    DEFAULT_MAX_CONCURRENT_TRANSFERS
}

impl Default for TransferSettings {
    fn default() -> Self {
        Self {
            part_size_mib: None,
            max_concurrent_parts: DEFAULT_MAX_CONCURRENT_PARTS,
            max_concurrent_transfers: DEFAULT_MAX_CONCURRENT_TRANSFERS,
        }
    }
}

fn part_size_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "partSizeMib must be an integer from {PART_SIZE_MIB_MIN} to {PART_SIZE_MIB_MAX}, or null for Auto"
    ))
}

fn parts_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "maxConcurrentParts must be an integer from {MAX_CONCURRENT_PARTS_MIN} to {MAX_CONCURRENT_PARTS_MAX}"
    ))
}

fn transfers_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "maxConcurrentTransfers must be an integer from {MAX_CONCURRENT_TRANSFERS_MIN} to {MAX_CONCURRENT_TRANSFERS_MAX}"
    ))
}

fn part_size_ok(v: Option<u32>) -> bool {
    v.is_none_or(|v| (PART_SIZE_MIB_MIN..=PART_SIZE_MIB_MAX).contains(&v))
}

fn parts_ok(v: u32) -> bool {
    (MAX_CONCURRENT_PARTS_MIN..=MAX_CONCURRENT_PARTS_MAX).contains(&v)
}

fn transfers_ok(v: u32) -> bool {
    (MAX_CONCURRENT_TRANSFERS_MIN..=MAX_CONCURRENT_TRANSFERS_MAX).contains(&v)
}

impl TransferSettings {
    /// Rejects (`InvalidInput`, naming the field and its range) the first out-of-range field.
    pub fn validate(&self) -> crate::error::AppResult<()> {
        if !part_size_ok(self.part_size_mib) {
            return Err(part_size_error());
        }
        if !parts_ok(self.max_concurrent_parts) {
            return Err(parts_error());
        }
        if !transfers_ok(self.max_concurrent_transfers) {
            return Err(transfers_error());
        }
        Ok(())
    }

    /// Replaces each out-of-range field with its default (used for the on-disk file only).
    pub fn sanitized(self) -> Self {
        let d = Self::default();
        Self {
            part_size_mib: if part_size_ok(self.part_size_mib) { self.part_size_mib } else { d.part_size_mib },
            max_concurrent_parts: if parts_ok(self.max_concurrent_parts) {
                self.max_concurrent_parts
            } else {
                d.max_concurrent_parts
            },
            max_concurrent_transfers: if transfers_ok(self.max_concurrent_transfers) {
                self.max_concurrent_transfers
            } else {
                d.max_concurrent_transfers
            },
        }
    }

    /// Strict parse of the `update_settings` argument: every field must be present and an
    /// in-range integer (`partSizeMib` may be `null`). Non-integers (`2.5`, `"8"`, `-1`) and
    /// out-of-range values are `InvalidInput` naming the field. Unknown fields are ignored.
    pub fn from_json_strict(v: &serde_json::Value) -> crate::error::AppResult<Self> {
        let obj = v.as_object().ok_or_else(|| crate::error::AppError::invalid("settings must be an object"))?;
        let int = |name: &str, err: fn() -> crate::error::AppError| -> crate::error::AppResult<u32> {
            obj.get(name).and_then(serde_json::Value::as_u64).and_then(|n| u32::try_from(n).ok()).ok_or_else(err)
        };
        let part_size_mib = match obj.get("partSizeMib") {
            Some(serde_json::Value::Null) => None,
            Some(_) => Some(int("partSizeMib", part_size_error)?),
            None => return Err(part_size_error()),
        };
        let s = Self {
            part_size_mib,
            max_concurrent_parts: int("maxConcurrentParts", parts_error)?,
            max_concurrent_transfers: int("maxConcurrentTransfers", transfers_error)?,
        };
        s.validate()?;
        Ok(s)
    }
}

/// Current time as ISO-8601 UTC with millisecond precision.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Formats an S3 timestamp as ISO-8601 UTC.
pub fn fmt_dt(dt: Option<&aws_smithy_types::DateTime>) -> Option<String> {
    dt.and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok())
}

/// Strips the surrounding quotes S3 puts around ETags.
pub fn clean_etag(etag: Option<&str>) -> Option<String> {
    etag.map(|e| e.trim_matches('"').to_string())
}

/// Last path segment of a key or prefix ("a/b/c/" -> "c", "a/b.txt" -> "b.txt").
pub fn last_segment(path: &str) -> String {
    // Strip exactly one trailing '/' (a folder prefix); "a//" is the folder named "" inside "a/".
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_config_json() {
        let c: ConnectionConfig = serde_json::from_str(
            r#"{"kind":"static","accessKeyId":"a","secretAccessKey":"b","region":"us-east-1","endpoint":"http://x","forcePathStyle":false}"#,
        )
        .expect("parse static");
        assert!(matches!(c, ConnectionConfig::Static { force_path_style: Some(false), .. }));
        let p: ConnectionConfig =
            serde_json::from_str(r#"{"kind":"profile","profile":"dev"}"#).expect("parse profile");
        assert!(matches!(p, ConnectionConfig::Profile { region: None, endpoint: None, .. }));
    }

    #[test]
    fn transfer_json() {
        let t = Transfer {
            id: "x".into(),
            kind: TransferKind::Download,
            bucket: "b".into(),
            key: "k".into(),
            local_path: "p".into(),
            total_bytes: 1,
            transferred_bytes: 0,
            parts_total: 1,
            parts_done: 0,
            bytes_per_sec: 0,
            status: TransferStatus::Queued,
            error: None,
            started_at: now_iso(),
            finished_at: None,
        };
        let v = serde_json::to_value(&t).expect("ser");
        assert_eq!(v["kind"], "download");
        assert_eq!(v["status"], "queued");
        assert!(v.get("localPath").is_some());
        assert!(v.get("bytesPerSec").is_some());
        let e = serde_json::to_value(crate::error::AppError::not_connected()).expect("ser");
        assert_eq!(e["code"], "NotConnected");
    }

    #[test]
    fn segments() {
        assert_eq!(last_segment("a/b/c/"), "c");
        assert_eq!(last_segment("a/b.txt"), "b.txt");
        assert_eq!(last_segment("top"), "top");
        assert_eq!(last_segment("a//"), "");
        assert_eq!(last_segment("/"), "");
        assert_eq!(last_segment("/foo/"), "foo");
    }
}
