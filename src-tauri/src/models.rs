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
