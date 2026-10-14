//! The local computer as a pane source (v0.9.0, "Pane sources" in `docs/CONTRACT.md`): roots,
//! bounded directory listings, new folder, rename, move to the recycle bin and a bounded size count.
//!
//! Free of Tauri types and blocking: the command layer (`commands/local.rs`) runs every function
//! here on a blocking thread.
//!
//! Rules (data safety):
//! - Only absolute paths with a drive letter (Windows) or a leading `/`; no `..` component. UNC
//!   (`\\server\share`) and device paths (`\\.\`, `\\?\`) are `InvalidInput`.
//! - Links (symbolic links, junctions) are never followed: listed as links, never listed into,
//!   never counted into, renamed and trashed as the link itself.
//! - Nothing here deletes permanently: `trash_paths` only moves to the recycle bin / trash, and on
//!   Windows refuses drives that have no recycle bin (anything but a fixed disk).
//! - Nothing here replaces an existing file or folder.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::batches::localname::{fold_with, sanitize_segment};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::search::SearchRegistry;

/// Most entries one `list_local_dir` returns (`LOCAL_LIMITS.maxEntries`).
pub const LOCAL_MAX_ENTRIES: usize = 50_000;
/// Most entries one `local_dir_size` looks at (`LOCAL_LIMITS.dirSizeMaxEntries`).
pub const LOCAL_DIR_SIZE_MAX_ENTRIES: u64 = 200_000;
/// How many listed directories `open_local` remembers (most recent kept).
pub const LISTED_DIRS_MAX: usize = 1_000;
/// Most paths one `trash_local` call takes (same bound as a job's items).
pub const TRASH_MAX_PATHS: usize = crate::models::JOB_MAX_ITEMS;
/// `local_dir_size` scans that run at once; more wait for a slot (still cancellable).
pub const LOCAL_DIR_SIZE_PARALLEL: usize = 4;
/// Most roots `list_local_roots` returns.
const ROOTS_MAX: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalRootKind {
    Drive,
    Home,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalRoot {
    pub path: String,
    pub label: String,
    pub kind: LocalRootKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    /// The listed directory joined with the name, as the OS returns it.
    pub path: String,
    pub is_dir: bool,
    /// 0 for directories and links.
    pub size: u64,
    /// RFC 3339, `None` when the OS does not tell.
    pub modified: Option<String>,
    /// The entry itself is a symbolic link or junction (never followed; listed with the files).
    pub is_symlink: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    pub dirs: Vec<LocalEntry>,
    pub files: Vec<LocalEntry>,
    pub truncated: bool,
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    pub trashed: u64,
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirSize {
    pub files: u64,
    pub bytes: u64,
    pub truncated: bool,
}

fn io_error(what: &str, path: &str, e: &std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("Could not {what} {path}: {e}"))
}

/// Checks a path sent by the frontend and returns it unchanged as a `PathBuf`: absolute, with a
/// drive letter on Windows (no UNC or device path), no `..` component.
pub fn check_path(path: &str) -> AppResult<PathBuf> {
    if path.trim().is_empty() {
        return Err(AppError::invalid("A local path is required"));
    }
    let p = Path::new(path);
    #[cfg(windows)]
    if let Some(Component::Prefix(prefix)) = p.components().next() {
        if !matches!(prefix.kind(), std::path::Prefix::Disk(_)) {
            return Err(AppError::invalid(format!(
                "{path}: network (UNC) and device paths are not supported; use a path that starts with a drive letter"
            )));
        }
    }
    if !p.is_absolute() {
        return Err(AppError::invalid(format!("{path}: the path must be absolute")));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid(format!("{path}: the path must not contain \"..\"")));
    }
    Ok(p.to_path_buf())
}

/// [`check_path`], then: exists (`Io` with the OS message otherwise), is a directory and is not
/// itself a link (`InvalidInput`).
fn check_dir(path: &str) -> AppResult<PathBuf> {
    let dir = check_path(path)?;
    let meta = std::fs::symlink_metadata(&dir).map_err(|e| io_error("open", path, &e))?;
    if meta.file_type().is_symlink() {
        return Err(AppError::invalid(format!(
            "{path} is a link (symbolic link or junction); links are not followed"
        )));
    }
    if !meta.is_dir() {
        return Err(AppError::invalid(format!("{path} is not a folder")));
    }
    Ok(dir)
}

/// A dotfile, or (Windows) the hidden attribute.
fn is_hidden(name: &str, meta: Option<&std::fs::Metadata>) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if meta.is_some_and(|m| m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0) {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    false
}

fn rfc3339(t: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn sort_entries(v: &mut [LocalEntry]) {
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
}

/// `list_local_dir`: at most [`LOCAL_MAX_ENTRIES`] entries.
pub fn list_dir(path: &str, show_hidden: bool) -> AppResult<LocalListing> {
    list_dir_capped(path, show_hidden, LOCAL_MAX_ENTRIES)
}

/// Lists `path` without following any link: directories and files (links among the files), each
/// sorted by name (case-insensitive, then exact). Stops after `cap` shown entries
/// (`truncated: true` when more exist). Hidden entries are skipped unless `show_hidden`, and do not
/// count against the cap.
pub fn list_dir_capped(path: &str, show_hidden: bool, cap: usize) -> AppResult<LocalListing> {
    let dir = check_dir(path)?;
    let read = std::fs::read_dir(&dir).map_err(|e| io_error("read", path, &e))?;
    let mut out = LocalListing {
        parent: dir.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| p.to_string_lossy().into_owned()),
        ..LocalListing::default()
    };
    let mut shown = 0usize;
    for entry in read {
        // An entry that vanished or cannot be read mid-listing is left out.
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        // `DirEntry::file_type` / `metadata` never traverse a link (lstat; on Windows the
        // directory entry itself).
        let file_type = entry.file_type().ok();
        let meta = entry.metadata().ok();
        let hidden = is_hidden(&name, meta.as_ref());
        if hidden && !show_hidden {
            continue;
        }
        if shown >= cap {
            out.truncated = true;
            break;
        }
        shown += 1;
        let is_symlink = file_type.is_some_and(|t| t.is_symlink());
        let is_dir = !is_symlink && file_type.is_some_and(|t| t.is_dir());
        let size = if is_dir || is_symlink { 0 } else { meta.as_ref().map_or(0, std::fs::Metadata::len) };
        let modified = meta.as_ref().and_then(|m| m.modified().ok()).map(rfc3339);
        let e = LocalEntry {
            path: dir.join(entry.file_name()).to_string_lossy().into_owned(),
            name,
            is_dir,
            size,
            modified,
            is_symlink,
            hidden,
        };
        if is_dir {
            out.dirs.push(e);
        } else {
            out.files.push(e);
        }
    }
    sort_entries(&mut out.dirs);
    sort_entries(&mut out.files);
    Ok(out)
}

/// The canonical path of a directory just listed, for [`ListedDirs`] (`None` if it cannot be told).
pub fn canonical_dir(path: &str) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok().map(|c| crate::local_open::plain(&c))
}

/// Folds a name for "same name?" on the platform's file system.
fn fold_name(name: &str) -> String {
    fold_with(name, cfg!(any(windows, target_os = "macos")), cfg!(target_os = "macos"))
}

/// A typed name (new folder, rename): trimmed, not empty, without a path separator, then the
/// download file name rules ([`sanitize_segment`]).
fn clean_name(typed: &str) -> AppResult<String> {
    let t = typed.trim();
    if t.is_empty() {
        return Err(AppError::invalid("A name is required"));
    }
    if t.contains(['/', '\\']) {
        return Err(AppError::invalid("A name cannot contain / or \\"));
    }
    Ok(sanitize_segment(t))
}

/// `create_local_dir`: a new folder `name` (sanitized) in `parent`; refuses an existing name.
pub fn create_dir(parent: &str, name: &str) -> AppResult<PathBuf> {
    let dir = check_dir(parent)?;
    let clean = clean_name(name)?;
    let target = dir.join(&clean);
    // `create_dir` fails on any existing entry (file, folder or link): never replaces.
    match std::fs::create_dir(&target) {
        Ok(()) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::invalid(format!("{clean} already exists in {parent}")))
        }
        Err(e) => Err(io_error("create a folder in", parent, &e)),
    }
}

/// `rename_local`: renames `path` (a file, folder or link, never followed) to `new_name`
/// (sanitized) in the same folder. Refuses an existing target, except a change of case only
/// where the file system ignores case; never replaces.
pub fn rename(path: &str, new_name: &str) -> AppResult<PathBuf> {
    let src = check_path(path)?;
    let parent = src
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::invalid(format!("{path} cannot be renamed")))?;
    let old = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    std::fs::symlink_metadata(&src).map_err(|e| io_error("rename", path, &e))?;
    let clean = clean_name(new_name)?;
    if clean == old {
        return Ok(src);
    }
    let dst = parent.join(&clean);
    let same_entry = fold_name(&clean) == fold_name(&old);
    if !same_entry {
        match std::fs::symlink_metadata(&dst) {
            Ok(_) => return Err(AppError::invalid(format!("{clean} already exists"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("check", &dst.to_string_lossy(), &e)),
        }
    }
    rename_no_replace(&src, &dst).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::invalid(format!("{clean} already exists"))
        } else {
            io_error("rename", path, &e)
        }
    })?;
    Ok(dst)
}

/// Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`, so an existing target is an error
/// even if it appeared after the check (`std::fs::rename` would replace a file).
#[cfg(windows)]
fn rename_no_replace(src: &Path, dst: &Path) -> std::io::Result<()> {
    let (s, d) = (wide(src.as_os_str()), wide(dst.as_os_str()));
    // SAFETY: both are NUL-terminated UTF-16 strings that outlive the call.
    if unsafe { ffi::MoveFileExW(s.as_ptr(), d.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Elsewhere: the target was checked to be absent just before (a small window remains between
/// the check and the rename).
#[cfg(not(windows))]
fn rename_no_replace(src: &Path, dst: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(dst).is_ok() {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(src, dst)
}

#[cfg(windows)]
fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
mod ffi {
    pub const DRIVE_FIXED: u32 = 3;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetLogicalDrives() -> u32;
        pub fn GetDriveTypeW(root: *const u16) -> u32;
        pub fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
}

/// Windows: only a fixed disk has a recycle bin. On a removable, network, optical or RAM drive
/// the shell would delete permanently, so those are refused.
#[cfg(windows)]
fn has_recycle_bin(p: &Path) -> Result<(), String> {
    let Some(Component::Prefix(prefix)) = p.components().next() else {
        return Err("Not a drive path".into());
    };
    let std::path::Prefix::Disk(letter) = prefix.kind() else {
        return Err("Not a drive path".into());
    };
    let letter = (letter as char).to_ascii_uppercase();
    let root = wide(std::ffi::OsStr::new(&format!("{letter}:\\")));
    // SAFETY: a NUL-terminated UTF-16 string that outlives the call.
    let kind = unsafe { ffi::GetDriveTypeW(root.as_ptr()) };
    if kind == ffi::DRIVE_FIXED {
        Ok(())
    } else {
        Err(format!(
            "Drive {letter}: has no recycle bin (removable, network or optical drive); nothing was deleted. Delete it in your file manager."
        ))
    }
}

fn trash_context() -> trash::TrashContext {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::new();
    // The Finder method asks for permission to control Finder; the file manager call does not.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx
}

/// Moves one path (as given; a link is moved as the link) to the recycle bin, and checks it is
/// gone afterwards.
fn trash_one(ctx: &trash::TrashContext, path: &str) -> Result<(), String> {
    let p = check_path(path).map_err(|e| e.message)?;
    if p.parent().is_none_or(|q| q.as_os_str().is_empty()) {
        return Err("A drive or root folder cannot be deleted".into());
    }
    match std::fs::symlink_metadata(&p) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("It does not exist (any more)".into()),
        Err(e) => return Err(format!("Could not read it: {e}")),
    }
    #[cfg(windows)]
    has_recycle_bin(&p)?;
    // The trash crate canonicalizes only the parent and appends the name, so a link itself is
    // moved, never its target.
    ctx.delete(&p).map_err(|e| format!("Could not move it to the recycle bin: {e}"))?;
    // Never trust silence: it counts as trashed only when it is gone.
    match std::fs::symlink_metadata(&p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("It is still there after moving it to the recycle bin".into()),
        Err(e) => Err(format!("Could not check it after moving it to the recycle bin: {e}")),
    }
}

/// `trash_local`: each path on its own; a failure is reported for that path and the rest go on.
/// Blocking, and on Windows it initializes COM on the calling thread: call it on a thread of its
/// own (see `commands/local.rs`).
pub fn trash_paths(paths: &[String]) -> AppResult<TrashResult> {
    if paths.len() > TRASH_MAX_PATHS {
        return Err(AppError::invalid(format!("At most {TRASH_MAX_PATHS} items can be deleted at once")));
    }
    let ctx = trash_context();
    let mut out = TrashResult::default();
    for path in paths {
        match trash_one(&ctx, path) {
            Ok(()) => out.trashed += 1,
            Err(message) => out.failed.push(TrashFailure { path: path.clone(), message }),
        }
    }
    Ok(out)
}

/// Counts files and bytes under `path`, never following a link (links are neither counted nor
/// entered). Looks at no more than `limit` entries (`truncated: true` when it stopped there).
/// Unreadable subfolders are skipped; an unreadable `path` is `Io`. `stop` set: `Cancelled`.
pub fn dir_size(path: &str, limit: u64, stop: &AtomicBool) -> AppResult<LocalDirSize> {
    let root = check_dir(path)?;
    let mut out = LocalDirSize::default();
    let mut seen: u64 = 0;
    let first = std::fs::read_dir(&root).map_err(|e| io_error("read", path, &e))?;
    let mut pending = vec![first];
    while let Some(read) = pending.pop() {
        for entry in read {
            if stop.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let Ok(entry) = entry else { continue };
            if seen >= limit {
                out.truncated = true;
                return Ok(out);
            }
            seen += 1;
            let Ok(t) = entry.file_type() else { continue };
            if t.is_symlink() {
                continue;
            }
            if t.is_dir() {
                if let Ok(sub) = std::fs::read_dir(entry.path()) {
                    pending.push(sub);
                }
            } else if t.is_file() {
                out.files += 1;
                out.bytes = out.bytes.saturating_add(entry.metadata().map_or(0, |m| m.len()));
            }
        }
    }
    Ok(out)
}

/// Sets the flag when dropped: a cancelled scan's future is dropped, which stops its walk.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Running `local_dir_size` scans by `scanId`: a newer call with the id cancels the older one, as
/// does `cancel_folder_size` with that id. At most [`LOCAL_DIR_SIZE_PARALLEL`] walk at once.
pub struct LocalDirSizes {
    running: SearchRegistry,
    slots: Semaphore,
}

impl Default for LocalDirSizes {
    fn default() -> Self {
        Self { running: SearchRegistry::new(), slots: Semaphore::new(LOCAL_DIR_SIZE_PARALLEL) }
    }
}

impl LocalDirSizes {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run(&self, id: &str, path: String) -> AppResult<LocalDirSize> {
        self.run_with_limit(id, path, LOCAL_DIR_SIZE_MAX_ENTRIES).await
    }

    async fn run_with_limit(&self, id: &str, path: String, limit: u64) -> AppResult<LocalDirSize> {
        let stop = Arc::new(AtomicBool::new(false));
        let guard = StopOnDrop(stop.clone());
        self.running
            .run(id, async move {
                let _guard = guard;
                let _slot = self.slots.acquire().await.map_err(|_| AppError::cancelled())?;
                tokio::task::spawn_blocking(move || dir_size(&path, limit, &stop)).await?
            })
            .await
    }

    pub fn cancel(&self, id: &str) {
        self.running.cancel(id);
    }

    pub fn running(&self) -> usize {
        self.running.running()
    }
}

/// The directories listed by `list_local_dir` this session (canonical, most recent last, at most
/// [`LISTED_DIRS_MAX`]): `open_local` opens files directly inside them.
#[derive(Default)]
pub struct ListedDirs {
    dirs: Mutex<VecDeque<PathBuf>>,
}

impl ListedDirs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, canonical: PathBuf) {
        let key = fold_name(&canonical.to_string_lossy());
        let mut dirs = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
        dirs.retain(|d| fold_name(&d.to_string_lossy()) != key);
        dirs.push_back(canonical);
        while dirs.len() > LISTED_DIRS_MAX {
            dirs.pop_front();
        }
    }

    pub fn snapshot(&self) -> Vec<PathBuf> {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|h| !h.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute())
}

/// `list_local_roots`: Windows, every ready drive letter; elsewhere `/` and the mounts under
/// `/Volumes` (macOS) or `/media`, `/run/media` and `/mnt` (one level, a folder named after the
/// user is looked into); then the home folder.
pub fn roots() -> Vec<LocalRoot> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        // SAFETY: no arguments; returns a bit mask of the drive letters.
        let mask = unsafe { ffi::GetLogicalDrives() };
        for i in 0..26u8 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i) as char;
            let root = format!("{letter}:\\");
            // Ready: an empty card reader or optical drive fails here.
            if std::fs::metadata(&root).is_ok_and(|m| m.is_dir()) {
                out.push(LocalRoot { path: root, label: format!("{letter}:"), kind: LocalRootKind::Drive });
            }
        }
    }
    #[cfg(not(windows))]
    {
        out.push(LocalRoot { path: "/".into(), label: "/".into(), kind: LocalRootKind::Drive });
        let bases: &[&str] = if cfg!(target_os = "macos") { &["/Volumes"] } else { &["/media", "/run/media", "/mnt"] };
        let user = std::env::var("USER").ok().filter(|u| !u.is_empty());
        for base in bases {
            for dir in plain_subdirs(Path::new(base)) {
                let is_user = user.as_deref().is_some_and(|u| dir.file_name().is_some_and(|n| n == u));
                if is_user && *base != "/mnt" {
                    for mount in plain_subdirs(&dir) {
                        push_mount(&mut out, &mount);
                    }
                } else {
                    push_mount(&mut out, &dir);
                }
            }
        }
    }
    out.truncate(ROOTS_MAX - 1);
    if let Some(home) = home_dir() {
        out.push(LocalRoot { path: home.to_string_lossy().into_owned(), label: "Home".into(), kind: LocalRootKind::Home });
    }
    out
}

/// Subfolders of `dir` that are not links, sorted.
#[cfg(not(windows))]
fn plain_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> =
        read.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink())).map(|e| e.path()).collect();
    v.sort();
    v
}

#[cfg(not(windows))]
fn push_mount(out: &mut Vec<LocalRoot>, p: &Path) {
    let label = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string());
    out.push(LocalRoot { path: p.to_string_lossy().into_owned(), label, kind: LocalRootKind::Drive });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{dir_link, ScratchDir};

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn code<T: std::fmt::Debug>(r: AppResult<T>) -> ErrorCode {
        r.expect_err("should fail").code
    }

    fn names(v: &[LocalEntry]) -> Vec<&str> {
        v.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn relative_unc_and_device_paths_are_refused() {
        let mut bad = vec!["", "  ", "relative", "sub/dir", "./x"];
        if cfg!(windows) {
            bad.extend([
                r"\\server\share",
                r"\\server\share\dir",
                "//server/share/dir",
                r"\\.\C:\",
                r"\\.\PhysicalDrive0",
                r"\\?\C:\Windows",
                r"\\?\UNC\server\share",
                r"C:relative",
                r"\no-drive",
                r"C:\Windows\..\Users",
            ]);
        } else {
            bad.push("/tmp/../etc");
        }
        for p in bad {
            assert_eq!(code(check_path(p)), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(list_dir(p, true)), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(dir_size(p, 10, &AtomicBool::new(false))), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(create_dir(p, "x")), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(rename(p, "x")), ErrorCode::InvalidInput, "{p:?}");
        }
        let ok = if cfg!(windows) { r"C:\Windows" } else { "/tmp" };
        assert_eq!(check_path(ok).expect("absolute"), PathBuf::from(ok));
    }

    #[test]
    fn lists_sorted_dirs_and_files_with_metadata() {
        let d = ScratchDir::new("local-list");
        std::fs::write(d.0.join("b.txt"), b"12345").expect("write");
        std::fs::write(d.0.join("A.txt"), b"1").expect("write");
        std::fs::write(d.0.join("c.bin"), b"").expect("write");
        std::fs::create_dir(d.0.join("zeta")).expect("mkdir");
        std::fs::create_dir(d.0.join("Alpha")).expect("mkdir");
        std::fs::write(d.0.join("zeta").join("inner"), b"x").expect("write");
        let l = list_dir(&s(&d.0), false).expect("list");
        assert_eq!(names(&l.dirs), ["Alpha", "zeta"]);
        assert_eq!(names(&l.files), ["A.txt", "b.txt", "c.bin"]);
        assert!(!l.truncated);
        assert_eq!(l.parent.as_deref(), d.0.parent().map(|p| p.to_string_lossy().into_owned()).as_deref());
        let b = &l.files[1];
        assert_eq!((b.size, b.is_dir, b.is_symlink, b.hidden), (5, false, false, false));
        assert_eq!(b.path, s(&d.0.join("b.txt")));
        assert!(b.modified.as_deref().is_some_and(|m| m.ends_with('Z') && m.contains('T')), "{:?}", b.modified);
        let z = &l.dirs[1];
        assert_eq!((z.size, z.is_dir), (0, true));
        // Serialized camelCase, as in types.ts.
        let v = serde_json::to_value(b).expect("ser");
        for k in ["name", "path", "isDir", "size", "modified", "isSymlink", "hidden"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        let v = serde_json::to_value(&l).expect("ser");
        for k in ["dirs", "files", "truncated", "parent"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        // A root has no parent.
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        assert_eq!(list_dir_capped(root, false, 1).expect("root").parent, None);
    }

    #[test]
    fn missing_file_and_unreadable_paths() {
        let d = ScratchDir::new("local-missing");
        let missing = d.0.join("nope");
        let e = list_dir(&s(&missing), true).expect_err("missing");
        assert_eq!(e.code, ErrorCode::Io);
        assert!(e.message.contains("nope"), "{}", e.message);
        std::fs::write(d.0.join("f.txt"), b"x").expect("write");
        assert_eq!(code(list_dir(&s(&d.0.join("f.txt")), true)), ErrorCode::InvalidInput);
    }

    #[test]
    fn hidden_entries() {
        let d = ScratchDir::new("local-hidden");
        std::fs::write(d.0.join(".dotfile"), b"x").expect("write");
        std::fs::create_dir(d.0.join(".dotdir")).expect("mkdir");
        std::fs::write(d.0.join("shown.txt"), b"x").expect("write");
        let attr = d.0.join("attr-hidden.txt");
        std::fs::write(&attr, b"x").expect("write");
        let attrib_ok = cfg!(windows)
            && std::process::Command::new("attrib").arg("+h").arg(&attr).output().is_ok_and(|o| o.status.success());
        if cfg!(windows) && !attrib_ok {
            println!("skipping the hidden attribute half: `attrib +h` is not available");
        }
        let l = list_dir(&s(&d.0), false).expect("list");
        let mut want = vec!["shown.txt"];
        if !attrib_ok {
            want.insert(0, "attr-hidden.txt");
        }
        assert_eq!(names(&l.files), want);
        assert!(l.dirs.is_empty());
        let all = list_dir(&s(&d.0), true).expect("list");
        assert_eq!(names(&all.dirs), [".dotdir"]);
        assert_eq!(names(&all.files), [".dotfile", "attr-hidden.txt", "shown.txt"]);
        let hidden: Vec<bool> = all.files.iter().map(|e| e.hidden).collect();
        assert_eq!(hidden, [true, attrib_ok, false]);
        assert!(all.dirs[0].hidden);
    }

    #[test]
    fn links_are_listed_never_followed() {
        let d = ScratchDir::new("local-links");
        let outside = ScratchDir::new("local-links-out");
        std::fs::write(outside.0.join("secret.txt"), b"secret").expect("write");
        let link = d.0.join("link");
        dir_link(&link, &outside.0);
        let l = list_dir(&s(&d.0), true).expect("list");
        assert!(l.dirs.is_empty());
        assert_eq!(names(&l.files), ["link"]);
        let e = &l.files[0];
        assert_eq!((e.is_symlink, e.is_dir, e.size), (true, false, 0));
        // Listing or sizing the link itself is refused.
        assert_eq!(code(list_dir(&s(&link), true)), ErrorCode::InvalidInput);
        assert_eq!(code(dir_size(&s(&link), 100, &AtomicBool::new(false))), ErrorCode::InvalidInput);
        assert_eq!(code(create_dir(&s(&link), "x")), ErrorCode::InvalidInput);
        assert!(!outside.0.join("x").exists());
    }

    #[test]
    fn cap_truncates() {
        let d = ScratchDir::new("local-cap");
        for i in 0..5 {
            std::fs::write(d.0.join(format!("f{i}")), b"").expect("write");
        }
        std::fs::write(d.0.join(".h"), b"").expect("write");
        let l = list_dir_capped(&s(&d.0), false, 5).expect("list");
        assert_eq!((l.files.len(), l.truncated), (5, false), "hidden entries do not count");
        let l = list_dir_capped(&s(&d.0), true, 5).expect("list");
        assert_eq!((l.files.len(), l.truncated), (5, true));
        let l = list_dir_capped(&s(&d.0), false, 3).expect("list");
        assert_eq!((l.files.len(), l.truncated), (3, true));
    }

    #[test]
    fn cap_is_fifty_thousand() {
        let d = ScratchDir::new("local-cap-50k");
        for i in 0..=LOCAL_MAX_ENTRIES {
            std::fs::File::create(d.0.join(format!("{i:05}"))).expect("create");
        }
        let l = list_dir(&s(&d.0), false).expect("list");
        assert_eq!(LOCAL_MAX_ENTRIES, 50_000);
        assert_eq!((l.files.len(), l.truncated), (50_000, true));
        std::fs::remove_file(d.0.join("00000")).expect("rm");
        let l = list_dir(&s(&d.0), false).expect("list");
        assert_eq!((l.files.len(), l.truncated), (50_000, false));
    }

    #[test]
    fn limits_match_types_ts() {
        let ts = include_str!("../../src/lib/types.ts");
        assert!(ts.contains("LOCAL_LIMITS = { maxEntries: 50_000, dirSizeMaxEntries: 200_000 }"));
        assert_eq!(LOCAL_DIR_SIZE_MAX_ENTRIES, 200_000);
    }

    #[test]
    fn create_folder_sanitizes_and_never_replaces() {
        let d = ScratchDir::new("local-mkdir");
        let p = s(&d.0);
        let made = create_dir(&p, "  a:b?  ").expect("create");
        assert_eq!(made, d.0.join("a_b_"));
        assert!(made.is_dir());
        assert_eq!(create_dir(&p, "CON").expect("reserved"), d.0.join("_CON"));
        assert_eq!(create_dir(&p, "dots...").expect("dots"), d.0.join("dots"));
        // Existing folder or file of that name: refused, untouched.
        std::fs::write(d.0.join("taken"), b"keep").expect("write");
        let e = create_dir(&p, "taken").expect_err("exists");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.contains("already exists"), "{}", e.message);
        assert_eq!(std::fs::read(d.0.join("taken")).expect("read"), b"keep");
        assert_eq!(code(create_dir(&p, "a_b_")), ErrorCode::InvalidInput);
        for bad in ["", "   ", "x/y", r"x\y"] {
            assert_eq!(code(create_dir(&p, bad)), ErrorCode::InvalidInput, "{bad:?}");
        }
        assert_eq!(code(create_dir(&s(&d.0.join("missing")), "x")), ErrorCode::Io);
    }

    #[test]
    fn rename_never_replaces() {
        let d = ScratchDir::new("local-rename");
        let a = d.0.join("a.txt");
        let b = d.0.join("b.txt");
        std::fs::write(&a, b"A").expect("write");
        std::fs::write(&b, b"B").expect("write");
        std::fs::create_dir(d.0.join("dir")).expect("mkdir");
        std::fs::create_dir(d.0.join("empty")).expect("mkdir");
        // Onto an existing file, and a folder onto an existing (empty) folder: refused, both kept.
        let e = rename(&s(&a), "b.txt").expect_err("exists");
        assert!(e.message.contains("already exists"), "{}", e.message);
        assert_eq!(code(rename(&s(&d.0.join("dir")), "empty")), ErrorCode::InvalidInput);
        assert_eq!(code(rename(&s(&a), "dir")), ErrorCode::InvalidInput);
        assert_eq!((std::fs::read(&a).expect("a"), std::fs::read(&b).expect("b")), (b"A".to_vec(), b"B".to_vec()));
        assert!(d.0.join("dir").is_dir() && d.0.join("empty").is_dir());
        if cfg!(windows) {
            // Another entry of the same name in a different case exists: refused on a case-insensitive disk.
            assert_eq!(code(rename(&s(&a), "B.TXT")), ErrorCode::InvalidInput);
        }
        // The no-replace primitive itself refuses an existing target.
        assert_eq!(rename_no_replace(&a, &b).expect_err("exists").kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&b).expect("b"), b"B");
        // Same directory only.
        for bad in ["../x.txt", "sub/x.txt", r"sub\x.txt", "", " "] {
            assert_eq!(code(rename(&s(&a), bad)), ErrorCode::InvalidInput, "{bad:?}");
        }
        // A plain rename (sanitized), and a change of case.
        let got = rename(&s(&a), "c:d.txt").expect("rename");
        assert_eq!(got, d.0.join("c_d.txt"));
        assert!(!a.exists() && got.is_file());
        let got = rename(&s(&got), "C_D.txt").expect("case only");
        let listed = list_dir(&s(&d.0), true).expect("list");
        assert!(names(&listed.files).contains(&"C_D.txt"), "{:?}", names(&listed.files));
        assert_eq!(std::fs::read(&got).expect("read"), b"A");
        assert_eq!(code(rename(&s(&d.0.join("missing")), "x")), ErrorCode::Io);
    }

    #[test]
    fn rename_a_link_renames_the_link() {
        let d = ScratchDir::new("local-rename-link");
        let outside = ScratchDir::new("local-rename-link-out");
        std::fs::write(outside.0.join("f"), b"x").expect("write");
        let link = d.0.join("link");
        dir_link(&link, &outside.0);
        let got = rename(&s(&link), "renamed").expect("rename");
        assert!(std::fs::symlink_metadata(&got).expect("meta").file_type().is_symlink());
        assert_eq!(outside.files(), ["f"]);
    }

    #[test]
    fn trash_moves_to_the_recycle_bin_and_keeps_link_targets() {
        let d = ScratchDir::new("local-trash");
        let outside = ScratchDir::new("local-trash-out");
        std::fs::write(outside.0.join("target.txt"), b"keep me").expect("write");
        let file = d.0.join("file.txt");
        std::fs::write(&file, b"x").expect("write");
        let folder = d.0.join("folder");
        std::fs::create_dir(&folder).expect("mkdir");
        std::fs::write(folder.join("inner.txt"), b"y").expect("write");
        let link = d.0.join("link");
        dir_link(&link, &outside.0);
        std::fs::write(d.0.join("kept.txt"), b"z").expect("write");

        let paths = vec![
            s(&file),
            "relative.txt".to_string(),
            s(&d.0.join("missing.txt")),
            s(&link),
            s(&folder),
            if cfg!(windows) { r"C:\".to_string() } else { "/".to_string() },
        ];
        let r = trash_paths(&paths).expect("trash");
        assert_eq!(r.trashed, 3, "{r:?}");
        let failed: Vec<&str> = r.failed.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(failed, [paths[1].as_str(), paths[2].as_str(), paths[5].as_str()]);
        assert!(r.failed.iter().all(|f| !f.message.is_empty()));
        // What survived: the untouched file, and the link's target with its content.
        assert_eq!(d.files(), ["kept.txt"]);
        assert_eq!(std::fs::read(outside.0.join("target.txt")).expect("target"), b"keep me");
        assert_eq!(outside.files(), ["target.txt"]);
        // Too many paths at once.
        assert_eq!(code(trash_paths(&vec![String::new(); TRASH_MAX_PATHS + 1])), ErrorCode::InvalidInput);
        assert_eq!(trash_paths(&[]).expect("empty"), TrashResult::default());
    }

    #[cfg(windows)]
    #[test]
    fn only_fixed_drives_have_a_recycle_bin() {
        assert!(has_recycle_bin(Path::new(r"C:\x")).is_ok());
        // A drive letter that is not mounted is not a fixed disk.
        // SAFETY: no arguments.
        let mask = unsafe { ffi::GetLogicalDrives() };
        if let Some(i) = (0..26u8).rev().find(|i| mask & (1 << i) == 0) {
            let p = format!("{}:\\x", (b'A' + i) as char);
            assert!(has_recycle_bin(Path::new(&p)).is_err(), "{p}");
        }
    }

    fn tree(d: &Path) {
        std::fs::write(d.join("a"), b"12345").expect("write");
        std::fs::create_dir_all(d.join("sub").join("deeper")).expect("mkdir");
        std::fs::write(d.join("sub").join("b"), b"123").expect("write");
        std::fs::write(d.join("sub").join("deeper").join("c"), b"12").expect("write");
    }

    #[test]
    fn dir_size_counts_without_following_links() {
        let d = ScratchDir::new("local-size");
        let outside = ScratchDir::new("local-size-out");
        tree(&d.0);
        std::fs::write(outside.0.join("big"), vec![0u8; 4096]).expect("write");
        dir_link(&d.0.join("sub").join("link"), &outside.0);
        let stop = AtomicBool::new(false);
        let got = dir_size(&s(&d.0), LOCAL_DIR_SIZE_MAX_ENTRIES, &stop).expect("size");
        assert_eq!(got, LocalDirSize { files: 3, bytes: 10, truncated: false });
        // Entries are bounded (folders and links count as entries).
        let got = dir_size(&s(&d.0), 2, &stop).expect("size");
        assert!(got.truncated && got.files <= 2, "{got:?}");
        let v = serde_json::to_value(got).expect("ser");
        assert_eq!(v.as_object().map(|o| o.len()), Some(3));
        assert_eq!(code(dir_size(&s(&d.0.join("missing")), 10, &stop)), ErrorCode::Io);
        // A set flag stops the walk.
        let e = dir_size(&s(&d.0), 100, &AtomicBool::new(true)).expect_err("stopped");
        assert!(e.is_cancelled());
    }

    #[test]
    fn dropping_a_scan_stops_its_walk() {
        let flag = Arc::new(AtomicBool::new(false));
        drop(StopOnDrop(flag.clone()));
        assert!(flag.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn dir_size_scans_are_cancellable_by_id() {
        let d = ScratchDir::new("local-size-cancel");
        tree(&d.0);
        let scans = Arc::new(LocalDirSizes::new());
        // Hold every slot so the scans wait (deterministically) until released.
        let held = scans.slots.acquire_many(LOCAL_DIR_SIZE_PARALLEL as u32).await.expect("slots");
        let spawn = |id: &'static str| {
            let (scans, p) = (scans.clone(), s(&d.0));
            tokio::spawn(async move { scans.run(id, p).await })
        };
        let a = spawn("x");
        let other = spawn("y");
        while scans.running() < 2 {
            tokio::task::yield_now().await;
        }
        // A newer call with the same id cancels the older one.
        let b = spawn("x");
        assert!(a.await.expect("join").expect_err("replaced").is_cancelled());
        // `cancel` by id.
        scans.cancel("y");
        assert!(other.await.expect("join").expect_err("cancelled").is_cancelled());
        scans.cancel("unknown");
        drop(held);
        assert_eq!(b.await.expect("join").expect("size"), LocalDirSize { files: 3, bytes: 10, truncated: false });
        assert_eq!(scans.running(), 0);
        // The bound applies through the registry too.
        let got = scans.run_with_limit("z", s(&d.0), 1).await.expect("size");
        assert!(got.truncated);
    }

    #[test]
    fn listed_dirs_are_bounded_and_deduplicated() {
        let l = ListedDirs::new();
        for i in 0..LISTED_DIRS_MAX + 5 {
            l.record(PathBuf::from(format!("/d/{i}")));
        }
        let snap = l.snapshot();
        assert_eq!(snap.len(), LISTED_DIRS_MAX);
        assert_eq!(snap[0], PathBuf::from("/d/5"));
        l.record(PathBuf::from("/d/5"));
        let snap = l.snapshot();
        assert_eq!(snap.len(), LISTED_DIRS_MAX);
        assert_eq!(snap.last(), Some(&PathBuf::from("/d/5")));
        assert_eq!(snap[0], PathBuf::from("/d/6"));
    }

    #[test]
    fn roots_include_home_and_a_drive() {
        let r = roots();
        assert!(r.iter().any(|x| x.kind == LocalRootKind::Home));
        assert!(r.iter().any(|x| x.kind == LocalRootKind::Drive));
        if cfg!(windows) {
            assert!(r.iter().any(|x| x.path == r"C:\" && x.label == "C:"), "{r:?}");
        }
        assert!(r.iter().all(|x| Path::new(&x.path).is_absolute()));
        let v = serde_json::to_value(&r[0]).expect("ser");
        assert_eq!(v["kind"], "drive");
    }
}
