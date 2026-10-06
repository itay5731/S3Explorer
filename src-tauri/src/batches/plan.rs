//! Planning a folder transfer: what to transfer, where, what already exists, what cannot be
//! done. Planning changes nothing, locally or in the bucket.
//!
//! - Upload: walk the local folder (no symlinks or junctions followed), map each file's relative
//!   path to `prefix + "a/b.txt"`, then list the destination prefix once to find existing keys.
//! - Download: list the prefix without delimiter, map each key below it to a sanitized local
//!   path (see [`super::localname`]), refuse keys that would share a local file, then check
//!   which local files already exist.
//!
//! Both stop at [`BATCH_MAX_FILES`] / [`BATCH_MAX_BYTES`] with `truncated` set.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use aws_sdk_s3::Client;
use tokio_util::sync::CancellationToken;

use super::localname::{local_components, LocalTree};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{
    BatchError, BatchKind, BatchPlanRequest, BatchPreview, BATCH_MAX_BYTES, BATCH_MAX_FILES,
    BATCH_MAX_NOTES,
};
use crate::ops::{listing_error, next_list_page, NextPage};

/// S3's limit on the length of a key, in UTF-8 bytes.
const MAX_KEY_BYTES: usize = 1024;
/// Local paths longer than this are noted (Windows tools such as Explorer may not open them).
const LONG_PATH_CHARS: usize = 260;

/// One file of the plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    pub key: String,
    pub local: PathBuf,
    pub size: u64,
    /// Something already exists at the destination (object for uploads, file for downloads).
    pub exists: bool,
}

#[derive(Debug, Default)]
pub struct Plan {
    /// In path (key) order.
    pub files: Vec<PlannedFile>,
    /// Files that will not be transferred and count as failed (collisions, unreadable, ...).
    pub failures: Vec<BatchError>,
    /// Upload: local files (or folders) that could not be read; also in `failures`.
    pub unreadable: u64,
    pub notes: Vec<String>,
    /// Planning stopped at a limit; `limit_error` says which.
    pub truncated: bool,
    pub limit_error: Option<String>,
}

impl Plan {
    fn note(&mut self, n: String) {
        if self.notes.len() < BATCH_MAX_NOTES {
            self.notes.push(n);
        }
    }

    fn fail(&mut self, path: String, message: String) {
        self.note(format!("{path}: {message}"));
        self.failures.push(BatchError { path, message });
    }

    /// Entries counted against the file limit.
    fn count(&self) -> u64 {
        (self.files.len() + self.failures.len()) as u64
    }

    fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    /// Stops planning when a limit is exceeded. `count` / `bytes` include the entry that was
    /// just found, so a limit error names a count above the limit.
    fn over_limit(&mut self, count: u64, bytes: u64) -> bool {
        let e = limit_error(count, bytes);
        if let Some(msg) = &e {
            self.truncated = true;
            self.note(msg.clone());
            self.limit_error = e;
        }
        self.truncated
    }

    /// What `preview_batch` reports: `files` / `bytes` count every file that can be transferred,
    /// whatever the conflict policy; `conflicts` is the subset that already exists (the UI
    /// works out "skip" from the two).
    pub fn preview(&self) -> BatchPreview {
        let conflicts = self.files.iter().filter(|f| f.exists).count() as u64;
        BatchPreview {
            files: self.files.len() as u64,
            bytes: self.bytes(),
            conflicts,
            skipped_unreadable: self.unreadable,
            truncated: self.truncated,
            notes: self.notes.clone(),
        }
    }
}

/// The error for a batch over the limits (`None` within them).
pub fn limit_error(count: u64, bytes: u64) -> Option<String> {
    if count > BATCH_MAX_FILES {
        Some(format!(
            "Too many files for one folder transfer: more than {} (the limit). Transfer its sub-folders separately.",
            fmt_count(BATCH_MAX_FILES)
        ))
    } else if bytes > BATCH_MAX_BYTES {
        Some(format!(
            "Too much data for one folder transfer: more than 1 TiB in the first {} files (the limit is 1 TiB). Transfer its sub-folders separately.",
            fmt_count(count)
        ))
    } else {
        None
    }
}

/// `1234567` -> `"1,234,567"`.
pub fn fmt_count(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Checks the request without touching the disk or the network.
pub fn validate(req: &BatchPlanRequest) -> AppResult<()> {
    if req.bucket.trim().is_empty() {
        return Err(AppError::invalid("Bucket name is required"));
    }
    match req.kind {
        BatchKind::Upload if !(req.prefix.is_empty() || req.prefix.ends_with('/')) => {
            return Err(AppError::invalid("The destination prefix must be empty or end with \"/\""))
        }
        BatchKind::Download if req.prefix.is_empty() || !req.prefix.ends_with('/') => {
            return Err(AppError::invalid("A folder prefix ending with \"/\" is required"))
        }
        _ => {}
    }
    let local = Path::new(&req.local_path);
    if req.local_path.trim().is_empty() {
        return Err(AppError::invalid("A local folder is required"));
    }
    if !local.is_absolute() {
        return Err(AppError::invalid(format!("The local folder must be an absolute path: {}", req.local_path)));
    }
    if local.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid(format!("The local folder must not contain \"..\": {}", req.local_path)));
    }
    Ok(())
}

/// Plans `req`. `check_existing`: find what already exists at the destination (always for a
/// preview; for a start only when it matters, i.e. under `skip` for uploads; downloads always
/// check, because a folder in the way of a file is a failure either way).
pub async fn plan(req: &BatchPlanRequest, client: &Client, cancel: &CancellationToken, check_existing: bool) -> AppResult<Plan> {
    validate(req)?;
    match req.kind {
        BatchKind::Upload => {
            let root = PathBuf::from(&req.local_path);
            let prefix = req.prefix.clone();
            let c = cancel.clone();
            let mut plan = tokio::task::spawn_blocking(move || walk_upload(&root, &prefix, &c)).await??;
            if check_existing && !plan.files.is_empty() {
                let existing = list_keys(client, &req.bucket, &req.prefix, cancel, None).await?.0;
                let existing: HashSet<String> = existing.into_iter().map(|(k, _)| k).collect();
                for f in &mut plan.files {
                    f.exists = existing.contains(&f.key);
                }
            }
            Ok(plan)
        }
        BatchKind::Download => {
            let root = PathBuf::from(&req.local_path);
            if let Ok(m) = tokio::fs::metadata(&root).await {
                if !m.is_dir() {
                    return Err(AppError::invalid(format!("{} is a file, not a folder", root.display())));
                }
            }
            let (listed, stopped) = list_keys(client, &req.bucket, &req.prefix, cancel, Some(BATCH_MAX_FILES + 1)).await?;
            let mut plan = map_download(&req.prefix, &listed, &root);
            if stopped && !plan.truncated {
                plan.over_limit(BATCH_MAX_FILES + 1, plan.bytes());
            }
            let c = cancel.clone();
            tokio::task::spawn_blocking(move || mark_existing_local(plan, &c)).await?
        }
    }
}

/// Lists every key under `prefix` (no delimiter), in listing order, following continuation
/// tokens by the `next_list_page` rules. With `cap`, stops after at least that many file keys
/// (folder markers, keys ending in "/", are not counted) and says so.
pub(crate) async fn list_keys(
    client: &Client,
    bucket: &str,
    prefix: &str,
    cancel: &CancellationToken,
    cap: Option<u64>,
) -> AppResult<(Vec<(String, u64)>, bool)> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    let mut files = 0u64;
    loop {
        if cap.is_some_and(|c| files >= c) {
            return Ok((out, true));
        }
        let req = client.list_objects_v2().bucket(bucket).prefix(prefix).set_continuation_token(token.clone()).send();
        let resp = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AppError::cancelled()),
            r = req => r?,
        };
        for o in resp.contents() {
            if let Some(k) = o.key() {
                files += u64::from(!k.ends_with('/'));
                out.push((k.to_string(), o.size().unwrap_or(0).max(0) as u64));
            }
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

/// Maps listed keys to local files under `root` (pure; see the module docs).
pub fn map_download(prefix: &str, listed: &[(String, u64)], root: &Path) -> Plan {
    let mut plan = Plan::default();
    let mut tree = LocalTree::default();
    let mut bytes = 0u64;
    for (key, size) in listed {
        let Some(rel) = key.strip_prefix(prefix) else {
            continue; // not below the prefix (a server that ignored it)
        };
        if rel.is_empty() {
            continue; // the folder marker itself
        }
        if rel.ends_with('/') {
            if *size > 0 {
                plan.fail(key.clone(), "Not downloaded: the key ends with \"/\", so it cannot be saved as a file".into());
            }
            continue; // a sub-folder marker
        }
        if plan.over_limit(plan.count() + 1, bytes + size) {
            break;
        }
        let comps = local_components(rel);
        let local = comps.iter().fold(root.to_path_buf(), |p, c| p.join(c));
        let shown = local.display().to_string();
        if let Err(c) = tree.claim(&comps, key) {
            plan.fail(key.clone(), c.message(&shown));
            continue;
        }
        if shown.chars().count() > LONG_PATH_CHARS {
            plan.note(format!("Long local path ({} characters): {shown}", shown.chars().count()));
        }
        bytes += size;
        plan.files.push(PlannedFile { key: key.clone(), local, size: *size, exists: false });
    }
    plan
}

/// Marks download targets that exist; a folder where a file should go is a failure.
fn mark_existing_local(mut plan: Plan, cancel: &CancellationToken) -> AppResult<Plan> {
    let files = std::mem::take(&mut plan.files);
    for (i, mut f) in files.into_iter().enumerate() {
        if i.is_multiple_of(512) && cancel.is_cancelled() {
            return Err(AppError::cancelled());
        }
        match std::fs::symlink_metadata(&f.local) {
            Ok(m) if m.is_dir() => {
                let msg = format!("Not downloaded: a folder exists at {}", f.local.display());
                plan.fail(f.key.clone(), msg);
                continue;
            }
            Ok(_) => f.exists = true,
            Err(_) => {}
        }
        plan.files.push(f);
    }
    Ok(plan)
}

/// `prefix + "a/b.txt"` for the relative path components, or why that cannot be a key.
pub fn upload_key(prefix: &str, rel: &[&std::ffi::OsStr]) -> Result<String, String> {
    let mut key = prefix.to_string();
    for (i, c) in rel.iter().enumerate() {
        let s = c.to_str().ok_or_else(|| "Not uploaded: the name is not valid Unicode, so it cannot be an S3 key".to_string())?;
        if i > 0 {
            key.push('/');
        }
        key.push_str(s);
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(format!("Not uploaded: the key would be longer than {MAX_KEY_BYTES} bytes"));
    }
    Ok(key)
}

/// Walks `root` for an upload (blocking; run it in `spawn_blocking`). Symbolic links and
/// junctions are skipped and noted, never followed; hidden and system files are included.
pub fn walk_upload(root: &Path, prefix: &str, cancel: &CancellationToken) -> AppResult<Plan> {
    let io = |what: &str, e: std::io::Error| AppError::new(ErrorCode::Io, format!("{what} {}: {e}", root.display()));
    let meta = std::fs::metadata(root).map_err(|e| io("Cannot open", e))?;
    if !meta.is_dir() {
        return Err(AppError::invalid(format!("{} is not a folder", root.display())));
    }
    let top = std::fs::read_dir(root).map_err(|e| io("Cannot read the folder", e))?;
    let mut plan = Plan::default();
    let mut bytes = 0u64;
    let mut seen = 0usize;
    let mut stack: Vec<(std::fs::ReadDir, PathBuf)> = vec![(top, PathBuf::new())];
    'walk: while let Some((dir, rel_dir)) = stack.last_mut() {
        let Some(item) = dir.next() else {
            stack.pop();
            continue;
        };
        let rel_dir = rel_dir.clone();
        seen += 1;
        if seen.is_multiple_of(256) && cancel.is_cancelled() {
            return Err(AppError::cancelled());
        }
        let entry = match item {
            Ok(e) => e,
            Err(e) => {
                plan.unreadable += 1;
                let shown = root.join(&rel_dir).display().to_string();
                plan.fail(shown, format!("Not uploaded: part of this folder could not be read ({e})"));
                continue;
            }
        };
        let path = entry.path();
        let shown = path.display().to_string();
        let rel = rel_dir.join(entry.file_name());
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(e) => {
                plan.unreadable += 1;
                plan.fail(shown, format!("Not uploaded: could not be read ({e})"));
                continue;
            }
        };
        if ft.is_symlink() {
            // On Windows this covers symbolic links and junctions (name-surrogate reparse points).
            plan.note(format!("Skipped symbolic link: {shown}"));
            continue;
        }
        if ft.is_dir() {
            match std::fs::read_dir(&path) {
                Ok(rd) => stack.push((rd, rel)),
                Err(e) => {
                    plan.unreadable += 1;
                    plan.fail(shown, format!("Not uploaded: the folder could not be read ({e})"));
                }
            }
            continue;
        }
        if !ft.is_file() {
            plan.note(format!("Skipped (not a regular file): {shown}"));
            continue;
        }
        let parts: Vec<&std::ffi::OsStr> = rel.iter().collect();
        let key = match upload_key(prefix, &parts) {
            Ok(k) => k,
            Err(msg) => {
                if plan.over_limit(plan.count() + 1, bytes) {
                    break 'walk;
                }
                plan.fail(shown, msg);
                continue;
            }
        };
        // Opening proves the file can be read now (permissions, locks); its size comes from the
        // open handle.
        let size = match std::fs::File::open(&path).and_then(|f| f.metadata()) {
            Ok(m) => m.len(),
            Err(e) => {
                if plan.over_limit(plan.count() + 1, bytes) {
                    break 'walk;
                }
                plan.unreadable += 1;
                plan.fail(shown, format!("Not uploaded: could not be read ({e})"));
                continue;
            }
        };
        if plan.over_limit(plan.count() + 1, bytes + size) {
            break;
        }
        bytes += size;
        plan.files.push(PlannedFile { key, local: path, size, exists: false });
    }
    plan.files.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConflictPolicy;
    use std::ffi::OsStr;

    fn req(kind: BatchKind, prefix: &str, local: &str) -> BatchPlanRequest {
        BatchPlanRequest {
            kind,
            bucket: "b".into(),
            prefix: prefix.into(),
            local_path: local.into(),
            on_conflict: ConflictPolicy::Skip,
        }
    }

    fn abs(p: &str) -> String {
        std::env::temp_dir().join(p).display().to_string()
    }

    #[test]
    fn request_validation() {
        assert!(validate(&req(BatchKind::Upload, "", &abs("x"))).is_ok());
        assert!(validate(&req(BatchKind::Upload, "a/b/", &abs("x"))).is_ok());
        assert!(validate(&req(BatchKind::Upload, "a/b", &abs("x"))).is_err());
        assert!(validate(&req(BatchKind::Download, "logs/", &abs("x"))).is_ok());
        assert!(validate(&req(BatchKind::Download, "", &abs("x"))).is_err(), "download needs a folder prefix");
        assert!(validate(&req(BatchKind::Download, "logs", &abs("x"))).is_err());
        assert!(validate(&req(BatchKind::Download, "a//", &abs("x"))).is_ok(), "a// is a legal prefix");
        assert!(validate(&req(BatchKind::Download, "logs/", "relative/dir")).is_err());
        assert!(validate(&req(BatchKind::Download, "logs/", "")).is_err());
        let up = std::env::temp_dir().join("a").join("..").join("b").display().to_string();
        assert!(validate(&req(BatchKind::Download, "logs/", &up)).is_err());
        let mut r = req(BatchKind::Upload, "", &abs("x"));
        r.bucket = " ".into();
        assert!(validate(&r).is_err());
    }

    #[test]
    fn upload_key_mapping() {
        let k = upload_key("dest/", &[OsStr::new("sub"), OsStr::new("file.txt")]).unwrap();
        assert_eq!(k, "dest/sub/file.txt");
        assert_eq!(upload_key("", &[OsStr::new("a b"), OsStr::new("été.txt")]).unwrap(), "a b/été.txt");
        // The folder's own name is not prepended; the prefix is used exactly as given.
        assert_eq!(upload_key("x//", &[OsStr::new("f")]).unwrap(), "x//f");
        let long = "n".repeat(1100);
        assert!(upload_key("", &[OsStr::new(&long)]).unwrap_err().contains("1024"));
        assert!(upload_key("", &[OsStr::new(&"n".repeat(1024))]).is_ok());
    }

    #[test]
    fn download_mapping_skips_markers_and_refuses_collisions() {
        let root = std::env::temp_dir().join("dl-root");
        let listed: Vec<(String, u64)> = [
            ("p/", 0),
            ("p/A.txt", 1),
            ("p/a.txt", 2),
            ("p/sub/", 0),
            ("p/sub/x.bin", 3),
            ("p/a//b", 4),
            ("p/data/", 9),
            ("p/con.txt", 5),
            ("p/../evil", 6),
        ]
        .iter()
        .map(|(k, s)| (k.to_string(), *s))
        .collect();
        let plan = map_download("p/", &listed, &root);
        let keys: Vec<&str> = plan.files.iter().map(|f| f.key.as_str()).collect();
        let case_insensitive = cfg!(any(windows, target_os = "macos"));
        let mut expected = vec!["p/A.txt", "p/sub/x.bin", "p/a//b", "p/con.txt", "p/../evil"];
        if !case_insensitive {
            expected.insert(1, "p/a.txt");
        }
        assert_eq!(keys, expected);
        let by_key = |k: &str| plan.files.iter().find(|f| f.key == k).unwrap().local.clone();
        assert_eq!(by_key("p/sub/x.bin"), root.join("sub").join("x.bin"));
        assert_eq!(by_key("p/a//b"), root.join("a").join("_").join("b"));
        assert_eq!(by_key("p/con.txt"), root.join("_con.txt"));
        assert_eq!(by_key("p/../evil"), root.join("_").join("evil"));
        assert!(plan.files.iter().all(|f| f.local.starts_with(&root)));
        let failed: Vec<&str> = plan.failures.iter().map(|f| f.path.as_str()).collect();
        let mut want_failed = vec!["p/data/"];
        if case_insensitive {
            want_failed.insert(0, "p/a.txt");
        }
        assert_eq!(failed, want_failed, "{:?}", plan.failures);
        assert!(!plan.truncated);
        assert_eq!(plan.notes.len(), plan.failures.len());
    }

    #[test]
    fn limits_stop_planning_with_truncated() {
        let root = std::env::temp_dir().join("dl-limit");
        let n = BATCH_MAX_FILES as usize + 5;
        let listed: Vec<(String, u64)> = (0..n).map(|i| (format!("p/{i:06}"), 1)).collect();
        let plan = map_download("p/", &listed, &root);
        assert!(plan.truncated);
        assert_eq!(plan.files.len() as u64, BATCH_MAX_FILES, "stops at the limit");
        assert!(plan.limit_error.as_deref().unwrap().contains("more than 50,000"), "{:?}", plan.limit_error);
        // Exactly at the limit is fine.
        let plan = map_download("p/", &listed[..BATCH_MAX_FILES as usize], &root);
        assert!(!plan.truncated && plan.limit_error.is_none());
        // Bytes: two half-TiB files fit, a third byte does not.
        let half = BATCH_MAX_BYTES / 2;
        let listed = vec![("p/a".to_string(), half), ("p/b".to_string(), half), ("p/c".to_string(), 1)];
        let plan = map_download("p/", &listed, &root);
        assert!(plan.truncated);
        assert_eq!(plan.files.len(), 2);
        assert!(plan.limit_error.as_deref().unwrap().contains("1 TiB"), "{:?}", plan.limit_error);
        assert_eq!(limit_error(BATCH_MAX_FILES, BATCH_MAX_BYTES), None);
    }

    #[test]
    fn preview_counts_every_file_and_caps_notes() {
        let f = |key: &str, size: u64, exists: bool| PlannedFile { key: key.into(), local: PathBuf::from(key), size, exists };
        let plan = Plan {
            files: vec![f("a", 10, false), f("b", 20, true), f("c", 30, true)],
            failures: vec![BatchError { path: "x".into(), message: "m".into() }],
            unreadable: 1,
            notes: vec!["n".into()],
            truncated: false,
            limit_error: None,
        };
        let p = plan.preview();
        assert_eq!((p.files, p.bytes, p.conflicts, p.skipped_unreadable), (3, 60, 2, 1), "conflicts are a subset of files");
        let mut many = Plan::default();
        for i in 0..200 {
            many.fail(format!("k{i}"), "m".into());
        }
        assert_eq!(many.preview().notes.len(), BATCH_MAX_NOTES);
    }

    #[test]
    fn counts_are_formatted() {
        assert_eq!(fmt_count(0), "0");
        assert_eq!(fmt_count(999), "999");
        assert_eq!(fmt_count(1204), "1,204");
        assert_eq!(fmt_count(50_000), "50,000");
        assert_eq!(fmt_count(1_234_567), "1,234,567");
    }

    #[test]
    fn upload_walk_maps_skips_and_sorts() {
        let dir = std::env::temp_dir().join(format!("s3x-walk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub").join("deeper")).unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        std::fs::write(dir.join("b.txt"), b"bb").unwrap();
        std::fs::write(dir.join("a file.txt"), b"a").unwrap();
        std::fs::write(dir.join("sub").join("été.txt"), b"ccc").unwrap();
        std::fs::write(dir.join("sub").join("deeper").join(".hidden"), b"").unwrap();
        let link_made = {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(dir.join("sub"), dir.join("link")).is_ok()
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(dir.join("sub"), dir.join("link")).is_ok()
            }
        };
        let plan = walk_upload(&dir, "up/", &CancellationToken::new()).unwrap();
        let keys: Vec<&str> = plan.files.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, ["up/a file.txt", "up/b.txt", "up/sub/deeper/.hidden", "up/sub/été.txt"]);
        assert_eq!(plan.files.iter().map(|f| f.size).sum::<u64>(), 6);
        assert!(plan.failures.is_empty() && plan.unreadable == 0);
        if link_made {
            assert!(plan.notes.iter().any(|n| n.starts_with("Skipped symbolic link")), "{:?}", plan.notes);
        }
        // Cancelled walks stop.
        let c = CancellationToken::new();
        c.cancel();
        // (Cancellation is checked every 256 entries; a tiny tree finishes anyway.)
        assert!(walk_upload(&dir, "", &c).is_ok());
        // A file is not a folder: InvalidInput (the UI tells dropped files from folders by it).
        let e = walk_upload(&dir.join("b.txt"), "", &CancellationToken::new()).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput, "{e:?}");
        // A missing folder is an Io error, not InvalidInput.
        let e = walk_upload(&dir.join("missing"), "", &CancellationToken::new()).unwrap_err();
        assert_eq!(e.code, ErrorCode::Io, "{e:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
