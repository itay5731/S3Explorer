//! Small local text files chosen by the user in a save/open dialog (keyboard bindings export and
//! import). The frontend never touches the file system directly; these two commands are the only
//! way, and they are restricted to absolute `.json` paths of at most [`TEXT_FILE_MAX_BYTES`].

use std::io::{Read, Write};
use std::path::{Component, Path};

use crate::error::{AppError, AppResult, ErrorCode};

/// Largest file `write_text_file` writes and `read_text_file` reads (`KEYBINDING_LIMITS.fileMaxBytes`).
pub const TEXT_FILE_MAX_BYTES: u64 = 65_536;

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || write_text(Path::new(&path), &content)).await?
}

#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || read_text(Path::new(&path))).await?
}

fn io_err(action: &str, e: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("Could not {action} the file: {e}"))
}

/// Absolute, no `..` component, ends in `.json` (any case).
fn check_path(path: &Path) -> AppResult<()> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid("The path must be absolute and must not contain \"..\"."));
    }
    let json = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !json {
        return Err(AppError::invalid("Only .json files can be read or written."));
    }
    Ok(())
}

/// Writes `content` to `path` atomically: a unique sibling temp file is written and flushed, then
/// renamed over the target. The parent directory must already exist; an existing symlink or
/// directory at `path` is refused.
pub fn write_text(path: &Path, content: &str) -> AppResult<()> {
    check_path(path)?;
    if content.len() as u64 > TEXT_FILE_MAX_BYTES {
        return Err(AppError::invalid(format!("The file content is larger than {TEXT_FILE_MAX_BYTES} bytes.")));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::invalid("The path has no parent folder."))?;
    match std::fs::metadata(parent) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(AppError::invalid("The parent of the path is not a folder.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::invalid("The folder for the file does not exist."));
        }
        Err(e) => return Err(io_err("check the folder for", e)),
    }
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err(AppError::invalid("The path is a link; writing through links is refused."));
        }
        Ok(m) if !m.is_file() => return Err(AppError::invalid("The path is not a regular file.")),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_err("check", e)),
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file.json".into());
    let tmp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        drop(f);
        // `rename` replaces an existing target on both Windows and Unix.
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io_err("write", e)
    })
}

/// Reads `path` as UTF-8, refusing a file larger than [`TEXT_FILE_MAX_BYTES`] before reading it.
pub fn read_text(path: &Path) -> AppResult<String> {
    check_path(path)?;
    let too_large = || AppError::invalid(format!("The file is larger than {TEXT_FILE_MAX_BYTES} bytes."));
    let file = std::fs::File::open(path).map_err(|e| io_err("open", e))?;
    let meta = file.metadata().map_err(|e| io_err("read", e))?;
    if !meta.is_file() {
        return Err(AppError::invalid("The path is not a regular file."));
    }
    if meta.len() > TEXT_FILE_MAX_BYTES {
        return Err(too_large());
    }
    // Bounded even if the file grows between the size check and the read.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(TEXT_FILE_MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| io_err("read", e))?;
    if bytes.len() as u64 > TEXT_FILE_MAX_BYTES {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| AppError::invalid("The file is not valid UTF-8 text."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("s3x-files-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn invalid<T: std::fmt::Debug>(r: AppResult<T>) -> String {
        let e = r.expect_err("should be rejected");
        assert_eq!(e.code, ErrorCode::InvalidInput, "{}", e.message);
        e.message
    }

    #[test]
    fn relative_path_refused() {
        invalid(write_text(Path::new("bindings.json"), "{}"));
        invalid(read_text(Path::new("bindings.json")));
        invalid(write_text(Path::new("sub/bindings.json"), "{}"));
        let dir = temp_dir("dotdot");
        invalid(write_text(&dir.join("..").join("x.json"), "{}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_extension_refused() {
        let dir = temp_dir("ext");
        for name in ["a.txt", "a.json.exe", "a", "a.jsonx", ".json"] {
            let p = dir.join(name);
            invalid(write_text(&p, "{}"));
            assert!(!p.exists(), "{name}");
            std::fs::write(&p, "{}").expect("write");
            invalid(read_text(&p));
        }
        // Case-insensitive extension.
        let upper = dir.join("A.JSON");
        write_text(&upper, "{}").expect("upper-case extension");
        assert_eq!(read_text(&upper).expect("read"), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn too_large_content_refused() {
        let dir = temp_dir("bigcontent");
        let p = dir.join("a.json");
        write_text(&p, &"x".repeat(65_536)).expect("at the limit");
        assert_eq!(read_text(&p).expect("read").len(), 65_536);
        invalid(write_text(&p, &"y".repeat(65_537)));
        assert_eq!(std::fs::read(&p).expect("read").len(), 65_536, "old file untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn too_large_file_refused() {
        let dir = temp_dir("bigfile");
        let p = dir.join("a.json");
        std::fs::write(&p, vec![b'x'; 65_537]).expect("write");
        assert!(invalid(read_text(&p)).contains("larger"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_utf8_refused() {
        let dir = temp_dir("utf8");
        let p = dir.join("a.json");
        std::fs::write(&p, [b'{', 0xff, 0xfe, b'}']).expect("write");
        assert!(invalid(read_text(&p)).contains("UTF-8"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_parent_refused() {
        let dir = temp_dir("noparent");
        let p = dir.join("missing").join("a.json");
        invalid(write_text(&p, "{}"));
        assert!(!dir.join("missing").exists(), "no folder created");
        // Reading a missing file is an OS failure.
        assert_eq!(read_text(&dir.join("none.json")).expect_err("missing").code, ErrorCode::Io);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_target_refused() {
        let dir = temp_dir("dirtarget");
        let p = dir.join("folder.json");
        std::fs::create_dir(&p).expect("mkdir");
        invalid(write_text(&p, "{}"));
        assert!(p.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn symlink_refused() {
        let dir = temp_dir("symlink");
        let target = dir.join("target.json");
        std::fs::write(&target, "original").expect("write");
        let link = dir.join("link.json");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link);
        if let Err(e) = made {
            // Windows without Developer Mode cannot create symlinks; nothing to test then.
            eprintln!("skipping symlink_refused: {e}");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        assert!(invalid(write_text(&link, "{}")).contains("link"));
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "original", "target untouched");
        assert!(std::fs::symlink_metadata(&link).expect("meta").file_type().is_symlink(), "link not replaced");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trip_and_overwrite() {
        let dir = temp_dir("roundtrip");
        let p = dir.join("bindings.json");
        let text = "{\"s3explorer\":\"keybindings\",\"version\":1,\"bindings\":{\"refresh\":[\"Mod+R\",\"F5\"]},\"note\":\"\u{fc}\"}";
        write_text(&p, text).expect("write");
        assert_eq!(read_text(&p).expect("read"), text);
        write_text(&p, "{}").expect("overwrite");
        assert_eq!(read_text(&p).expect("read"), "{}");
        // No temp files left behind.
        let names: Vec<_> = std::fs::read_dir(&dir).expect("ls").filter_map(Result::ok).map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("bindings.json")]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
