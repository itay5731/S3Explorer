//! Persisted transfer settings (`settings.json` in the app config dir).
//!
//! Free of Tauri types: the path is resolved by the caller (the Tauri `setup` hook), so the store
//! is unit-testable against a temp dir.
//!
//! Loading never fails: a missing, unreadable or unparsable file (including a field of the wrong
//! type) yields the defaults wholesale; a file that parses but has out-of-range values keeps its
//! valid fields and falls back to the default for each out-of-range one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::TransferSettings;

pub const SETTINGS_FILE: &str = "settings.json";

/// Reads settings from `path`, falling back to defaults (see module docs). Never fails.
pub fn load(path: &Path) -> TransferSettings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<TransferSettings>(&bytes).ok())
        .map(TransferSettings::sanitized)
        .unwrap_or_default()
}

/// Writes `settings` to `path` atomically: a unique temp file in the same directory is written and
/// flushed to disk, then renamed over the target. Creates the directory if missing.
pub fn save(path: &Path, settings: &TransferSettings) -> AppResult<()> {
    let io = |what: &str, e: std::io::Error| AppError::new(ErrorCode::Io, format!("Could not {what} settings: {e}"));
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| io("create the folder for", e))?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::new(ErrorCode::Unknown, format!("Could not serialize settings: {e}")))?;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| SETTINGS_FILE.into());
    let tmp = dir.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        drop(f);
        // `rename` replaces an existing target on both Windows and Unix.
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io("save", e)
    })
}

/// Current settings plus where they persist. `path: None` keeps them in memory only.
pub struct SettingsStore {
    path: Option<PathBuf>,
    current: Mutex<TransferSettings>,
    /// Serializes updates so the file, the in-memory value and whatever `apply` feeds always agree.
    update_lock: tokio::sync::Mutex<()>,
}

impl SettingsStore {
    /// Loads from `path` (defaults if absent/invalid) and persists future updates there.
    pub fn load(path: PathBuf) -> Self {
        let current = load(&path);
        Self { path: Some(path), current: Mutex::new(current), update_lock: tokio::sync::Mutex::new(()) }
    }

    /// In-memory store (no persistence), e.g. when the config dir cannot be resolved.
    pub fn in_memory(settings: TransferSettings) -> Self {
        Self { path: None, current: Mutex::new(settings), update_lock: tokio::sync::Mutex::new(()) }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn get(&self) -> TransferSettings {
        *self.current.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Validates, persists, then swaps the in-memory value and calls `apply` with it (all under one
    /// lock, so concurrent updates are applied in the same order they are stored). On a validation
    /// or disk error nothing changes.
    pub async fn update(
        &self,
        settings: TransferSettings,
        apply: impl FnOnce(&TransferSettings),
    ) -> AppResult<TransferSettings> {
        settings.validate()?;
        let _guard = self.update_lock.lock().await;
        if let Some(path) = self.path.clone() {
            tokio::task::spawn_blocking(move || save(&path, &settings)).await??;
        }
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = settings;
        apply(&settings);
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("s3explorer-settings-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    fn s(part: Option<u32>, parts: u32, transfers: u32) -> TransferSettings {
        TransferSettings { part_size_mib: part, max_concurrent_parts: parts, max_concurrent_transfers: transfers }
    }

    fn err_msg(r: AppResult<()>) -> String {
        let e = r.expect_err("should be rejected");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        e.message
    }

    #[test]
    fn defaults_match_contract() {
        let d = TransferSettings::default();
        assert_eq!(d, s(None, 8, 4));
        assert_eq!(
            serde_json::to_value(d).expect("ser"),
            json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4})
        );
        assert!(d.validate().is_ok());
    }

    #[test]
    fn validation_bounds() {
        // partSizeMib: null (Auto), min, max ok; min-1, max+1 rejected.
        for ok in [None, Some(PART_SIZE_MIB_MIN), Some(PART_SIZE_MIB_MAX)] {
            assert!(s(ok, 8, 4).validate().is_ok(), "{ok:?}");
        }
        for bad in [PART_SIZE_MIB_MIN - 1, PART_SIZE_MIB_MAX + 1] {
            let m = err_msg(s(Some(bad), 8, 4).validate());
            assert!(m.contains("partSizeMib") && m.contains("1 to 256"), "{m}");
        }
        for ok in [MAX_CONCURRENT_PARTS_MIN, MAX_CONCURRENT_PARTS_MAX] {
            assert!(s(None, ok, 4).validate().is_ok());
        }
        for bad in [MAX_CONCURRENT_PARTS_MIN - 1, MAX_CONCURRENT_PARTS_MAX + 1] {
            let m = err_msg(s(None, bad, 4).validate());
            assert!(m.contains("maxConcurrentParts") && m.contains("1 to 32"), "{m}");
        }
        for ok in [MAX_CONCURRENT_TRANSFERS_MIN, MAX_CONCURRENT_TRANSFERS_MAX] {
            assert!(s(None, 8, ok).validate().is_ok());
        }
        for bad in [MAX_CONCURRENT_TRANSFERS_MIN - 1, MAX_CONCURRENT_TRANSFERS_MAX + 1] {
            let m = err_msg(s(None, 8, bad).validate());
            assert!(m.contains("maxConcurrentTransfers") && m.contains("1 to 10"), "{m}");
        }
    }

    #[test]
    fn strict_parse_for_update_command() {
        let ok = TransferSettings::from_json_strict(
            &json!({"partSizeMib": 16, "maxConcurrentParts": 3, "maxConcurrentTransfers": 2, "extra": true}),
        )
        .expect("valid");
        assert_eq!(ok, s(Some(16), 3, 2));
        let auto = TransferSettings::from_json_strict(
            &json!({"partSizeMib": null, "maxConcurrentParts": 1, "maxConcurrentTransfers": 10}),
        )
        .expect("valid");
        assert_eq!(auto, s(None, 1, 10));

        let cases = [
            (json!({"partSizeMib": 2.5, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"partSizeMib": "8", "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"partSizeMib": 0, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"partSizeMib": null, "maxConcurrentParts": -1, "maxConcurrentTransfers": 4}), "maxConcurrentParts"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8.5, "maxConcurrentTransfers": 4}), "maxConcurrentParts"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 33, "maxConcurrentTransfers": 4}), "maxConcurrentParts"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 11}), "maxConcurrentTransfers"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4294967297u64}), "maxConcurrentTransfers"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8}), "maxConcurrentTransfers"),
        ];
        for (v, field) in cases {
            let e = TransferSettings::from_json_strict(&v).expect_err(&v.to_string());
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.starts_with(field), "{v} -> {}", e.message);
        }
        assert!(TransferSettings::from_json_strict(&json!([1, 2])).is_err());
    }

    #[test]
    fn file_round_trip() {
        let dir = temp_dir("roundtrip");
        // Directory is created on save if missing.
        let path = dir.join("nested").join(SETTINGS_FILE);
        let v = s(Some(32), 16, 2);
        save(&path, &v).expect("save");
        assert_eq!(load(&path), v);
        // Overwrite an existing file.
        let v2 = s(None, 1, 10);
        save(&path, &v2).expect("save again");
        assert_eq!(load(&path), v2);
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(SETTINGS_FILE)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_corrupt_partial_and_out_of_range_files() {
        let dir = temp_dir("load");
        let path = dir.join(SETTINGS_FILE);
        assert_eq!(load(&path), TransferSettings::default(), "missing");

        for corrupt in ["", "{", "not json", "[]", r#"{"maxConcurrentParts":"eight"}"#, r#"{"partSizeMib":-3}"#] {
            std::fs::write(&path, corrupt).expect("write");
            assert_eq!(load(&path), TransferSettings::default(), "corrupt: {corrupt}");
        }

        std::fs::write(&path, r#"{"maxConcurrentParts": 3, "futureField": {"x": 1}}"#).expect("write");
        assert_eq!(load(&path), s(None, 3, 4), "partial + unknown field");

        std::fs::write(&path, r#"{"partSizeMib": 999, "maxConcurrentParts": 0, "maxConcurrentTransfers": 2}"#)
            .expect("write");
        assert_eq!(load(&path), s(None, 8, 2), "out-of-range fields fall back individually");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn store_update_persists_and_applies() {
        let dir = temp_dir("store");
        let path = dir.join(SETTINGS_FILE);
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get(), TransferSettings::default());

        let mut applied = None;
        let v = s(Some(4), 3, 1);
        assert_eq!(store.update(v, |x| applied = Some(*x)).await.expect("update"), v);
        assert_eq!(applied, Some(v));
        assert_eq!(store.get(), v);
        assert_eq!(SettingsStore::load(path.clone()).get(), v, "reloaded from disk");

        // Invalid: rejected, nothing changes, apply not called.
        let mut called = false;
        let e = store.update(s(Some(0), 3, 1), |_| called = true).await.expect_err("invalid");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(!called);
        assert_eq!(store.get(), v);
        assert_eq!(load(&path), v);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn store_update_disk_failure_keeps_memory() {
        let dir = temp_dir("fail");
        // A regular file where the config directory should be makes create_dir_all fail.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").expect("write");
        let store = SettingsStore::load(blocker.join(SETTINGS_FILE));
        let mut called = false;
        let e = store.update(s(Some(4), 3, 1), |_| called = true).await.expect_err("io");
        assert_eq!(e.code, ErrorCode::Io);
        assert!(!called);
        assert_eq!(store.get(), TransferSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
