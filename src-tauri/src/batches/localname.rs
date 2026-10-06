//! Local file names for S3 keys (folder downloads), and the check that two keys never end up in
//! the same local file.
//!
//! S3 keys are opaque: a segment may hold `\`, `:`, `..`, control characters or a Windows
//! reserved name, and two different keys can map to one local path once sanitized (or, on a
//! case-insensitive disk, by case alone). The rule here is the frontend's `sanitizeFileName`
//! (`src/lib/format.ts`), applied to every segment of the key below the batch prefix.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// One key segment as a safe local file or folder name: `\ / : * ? " < > |` and control
/// characters become `_`, trailing dots and spaces are removed (Windows drops them silently),
/// an empty result or `.` / `..` becomes `_`, and a Windows reserved device name (CON, PRN, AUX,
/// NUL, COM1-9, LPT1-9, with or without an extension, any case) gets a leading `_`.
pub fn sanitize_segment(name: &str) -> String {
    let mut n: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 || c == '\u{7f}' => '_',
            c => c,
        })
        .collect();
    let kept = n.trim_end_matches(['.', ' ']).len();
    n.truncate(kept);
    if n.is_empty() || n == "." || n == ".." {
        n = "_".to_string();
    }
    if is_reserved(&n) {
        n.insert(0, '_');
    }
    n
}

/// Windows device names (ASCII case-insensitive), as in the frontend's `sanitizeFileName`:
/// `con prn aux nul conin$ conout$`, and `com` / `lpt` followed by exactly one of `1-9 ¹ ² ³`.
/// The stem is the text before the first `.`, with trailing spaces removed (Windows ignores
/// them: `CON .txt` is the console); leading spaces are kept.
pub const RESERVED_NAMES: [&str; 6] = ["con", "prn", "aux", "nul", "conin$", "conout$"];
pub const RESERVED_PORT_DIGITS: [char; 12] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '\u{b9}', '\u{b2}', '\u{b3}'];

fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ').to_ascii_lowercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return true;
    }
    let Some(rest) = stem.strip_prefix("com").or_else(|| stem.strip_prefix("lpt")) else {
        return false;
    };
    let mut chars = rest.chars();
    matches!((chars.next(), chars.next()), (Some(d), None) if RESERVED_PORT_DIGITS.contains(&d))
}

/// The message for a download target behind (or at) a link.
pub fn link_message(link: &Path) -> String {
    format!("Not downloaded: {} is a link to another location", link.display())
}

/// Finds a symbolic link or junction on the way from `root` to `path`: every existing folder
/// below `root` and `path` itself (`root` is the user's choice and is not checked). Writing
/// through one would put the file outside `root`. Stops at the first component that does not
/// exist (nothing below it can be a link yet). `cache` remembers folders already looked at.
///
/// Uses `FileType::is_symlink`, which on Windows means a name-surrogate reparse point (symbolic
/// links and junctions), not every reparse point: OneDrive / cloud placeholder folders are
/// reparse points too and are ordinary folders here.
pub fn link_below(root: &Path, path: &Path, cache: &mut HashMap<PathBuf, LinkState>) -> Option<PathBuf> {
    let rel = path.strip_prefix(root).ok()?;
    let mut cur = root.to_path_buf();
    let n = rel.components().count();
    for (i, c) in rel.components().enumerate() {
        cur.push(c);
        let last = i + 1 == n;
        let state = match cache.get(&cur) {
            Some(s) => *s,
            None => {
                let s = match std::fs::symlink_metadata(&cur) {
                    Ok(m) if m.file_type().is_symlink() => LinkState::Link,
                    Ok(_) => LinkState::Plain,
                    Err(_) => LinkState::Absent,
                };
                if !last {
                    cache.insert(cur.clone(), s);
                }
                s
            }
        };
        match state {
            LinkState::Link => return Some(cur),
            LinkState::Absent => return None,
            LinkState::Plain => {}
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Link,
    Plain,
    Absent,
}

/// The local path components for `rel` (a key with the batch prefix removed): split on `/` and
/// every segment sanitized, so `a//b` becomes `a/_/b`. The key itself is never changed.
pub fn local_components(rel: &str) -> Vec<String> {
    rel.split('/').map(sanitize_segment).collect()
}

/// Whether local paths compare without case on this OS (Windows and macOS by default).
const CASE_INSENSITIVE: bool = cfg!(any(windows, target_os = "macos"));

/// macOS file systems (APFS, HFS+) also treat NFC and NFD spellings as one name.
const NORMALIZATION_INSENSITIVE: bool = cfg!(target_os = "macos");

fn fold(path: &str) -> String {
    fold_with(path, CASE_INSENSITIVE, NORMALIZATION_INSENSITIVE)
}

/// The form two paths share when the file system sees them as the same file. Case is folded
/// per character with simple (one-to-one) uppercase mapping, like NTFS's upcase table, so
/// `ΣΣ`, `σσ` and `σς` collide (`str::to_lowercase` turns a final `Σ` into `ς` and misses it).
/// A character whose uppercase is several characters (`ß`) is kept as it is. With `nfc`
/// (macOS) the path is NFC-normalized first.
pub fn fold_with(path: &str, case_insensitive: bool, nfc: bool) -> String {
    use unicode_normalization::UnicodeNormalization;
    let normalized: String = if nfc { path.nfc().collect() } else { path.to_string() };
    if !case_insensitive {
        return normalized;
    }
    normalized
        .chars()
        .map(|c| {
            let mut up = c.to_uppercase();
            match (up.next(), up.next()) {
                (Some(u), None) => u,
                _ => c,
            }
        })
        .collect()
}

/// Why a key cannot be written locally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Collision {
    /// Another key already maps to this exact local file.
    SameFile { other: String },
    /// Another key needs this path as a folder (`a` vs `a/b`).
    IsFolderOf { other: String },
    /// A folder on this key's path is the file of another key (`a/b` vs `a`).
    UnderFileOf { other: String },
}

impl Collision {
    pub fn message(&self, local: &str) -> String {
        match self {
            Collision::SameFile { other } => {
                format!("Not downloaded: it would overwrite the local file of \"{other}\" ({local})")
            }
            Collision::IsFolderOf { other } => {
                format!("Not downloaded: {local} is needed as a folder for \"{other}\"")
            }
            Collision::UnderFileOf { other } => {
                format!("Not downloaded: a folder on its path ({local}) is the local file of \"{other}\"")
            }
        }
    }
}

/// The local files and folders claimed so far by the keys of one batch.
#[derive(Default)]
pub struct LocalTree {
    /// Folded relative file path -> the key that claimed it.
    files: HashMap<String, String>,
    /// Folded relative folder path -> the first key below it.
    dirs: HashMap<String, String>,
}

impl LocalTree {
    /// Claims the local file at `comps` for `key`, or says which earlier key is in the way. The
    /// first key (in listing order) wins; a refused key claims nothing.
    pub fn claim(&mut self, comps: &[String], key: &str) -> Result<(), Collision> {
        let full = fold(&comps.join("/"));
        if let Some(other) = self.files.get(&full) {
            return Err(Collision::SameFile { other: other.clone() });
        }
        if let Some(other) = self.dirs.get(&full) {
            return Err(Collision::IsFolderOf { other: other.clone() });
        }
        let mut ancestors = Vec::with_capacity(comps.len().saturating_sub(1));
        for i in 1..comps.len() {
            let dir = fold(&comps[..i].join("/"));
            if let Some(other) = self.files.get(&dir) {
                return Err(Collision::UnderFileOf { other: other.clone() });
            }
            ancestors.push(dir);
        }
        for d in ancestors {
            self.dirs.entry(d).or_insert_with(|| key.to_string());
        }
        self.files.insert(full, key.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rule_of_the_sanitizer() {
        // Reserved characters, each one.
        for c in ['\\', '/', ':', '*', '?', '"', '<', '>', '|'] {
            assert_eq!(sanitize_segment(&format!("a{c}b")), "a_b", "{c:?}");
        }
        // Control characters (C0 and DEL).
        assert_eq!(sanitize_segment("a\u{0}b\u{1f}c\u{7f}d\te"), "a_b_c_d_e");
        // Trailing dots and spaces are removed, leading ones kept.
        assert_eq!(sanitize_segment("name. . "), "name");
        assert_eq!(sanitize_segment(" .hidden"), " .hidden");
        assert_eq!(sanitize_segment("report.pdf "), "report.pdf");
        // Empty, ".", ".." and names that are only dots/spaces.
        for n in ["", ".", "..", "...", "  ", ". ."] {
            assert_eq!(sanitize_segment(n), "_", "{n:?}");
        }
        // Reserved device names, with and without extension, any case.
        for n in ["CON", "con", "Prn", "aux.txt", "NUL.tar.gz", "com1", "COM9.log", "lpt1", "LPT9"] {
            assert_eq!(sanitize_segment(n), format!("_{n}"), "{n:?}");
        }
        // Not reserved: COM0, COM10, a longer stem, a reserved word inside a name.
        for n in ["com0", "COM10", "console", "con-1.txt", "nul_", "lpt", "auxiliary.txt"] {
            assert_eq!(sanitize_segment(n), n, "{n:?}");
        }
        // The exact rule shared with the frontend: stem before the first ".", trailing spaces
        // removed; con prn aux nul conin$ conout$; com/lpt + one of 1-9 ¹ ² ³.
        for n in ["CON .txt", "nul   .tar.gz", "COM\u{b9}", "lpt\u{b2}.x", "CONIN$", "conout$.txt", "CONIN$ .log", "com\u{b3}"] {
            assert_eq!(sanitize_segment(n), format!("_{n}"), "{n:?} is reserved");
        }
        for n in [" CON.txt", "COM\u{2074}", "COM\u{b9}\u{b9}", "CONIN", "CONOUT$$", "CONIN$x", "COM0"] {
            assert_eq!(sanitize_segment(n), n, "{n:?} is not reserved");
        }
        // Reserved after trimming: "CON." -> "CON" -> "_CON".
        assert_eq!(sanitize_segment("CON."), "_CON");
        // Spaces and unicode are kept as they are.
        assert_eq!(sanitize_segment("my photo – été 📷.jpg"), "my photo – été 📷.jpg");
        // Drive-like and traversal-like segments cannot escape.
        assert_eq!(sanitize_segment("C:"), "C_");
        assert_eq!(sanitize_segment(".."), "_");
    }

    #[test]
    fn key_mapping_keeps_structure_and_never_escapes() {
        assert_eq!(local_components("a/b/c.txt"), ["a", "b", "c.txt"]);
        assert_eq!(local_components("a//b"), ["a", "_", "b"], "an empty segment becomes _");
        assert_eq!(local_components("/x"), ["_", "x"]);
        assert_eq!(local_components("../../etc/passwd"), ["_", "_", "etc", "passwd"]);
        assert_eq!(local_components("a\\..\\b"), ["a_.._b"]);
        assert_eq!(local_components("sub dir/ünï cødé.txt"), ["sub dir", "ünï cødé.txt"]);
        for comps in [local_components("../a"), local_components("a/./b"), local_components("C:/x")] {
            assert!(comps.iter().all(|c| !c.is_empty() && c != "." && c != ".." && !c.contains(['/', '\\', ':'])));
        }
    }

    #[test]
    fn folding_matches_the_file_systems() {
        // NTFS-like simple case folding: sigma forms collide, ß is not expanded.
        assert_eq!(fold_with("\u{3a3}\u{3a3}", true, false), fold_with("\u{3c3}\u{3c3}", true, false));
        assert_eq!(fold_with("\u{3c3}\u{3c2}", true, false), fold_with("\u{3a3}\u{3a3}", true, false));
        assert_ne!("\u{3a3}\u{3a3}".to_lowercase(), "\u{3c3}\u{3c3}".to_lowercase(), "why str::to_lowercase was wrong");
        assert_eq!(fold_with("stra\u{df}e", true, false), "STRA\u{df}E");
        assert_eq!(fold_with("A/b.TXT", true, false), fold_with("a/B.txt", true, false));
        // macOS: NFD and NFC spellings of é are one name (after case folding too).
        let (nfc, nfd) = ("caf\u{e9}.txt", "cafe\u{301}.txt");
        assert_eq!(fold_with(nfc, true, true), fold_with(nfd, true, true));
        assert_eq!(fold_with("CAF\u{c9}.TXT", true, true), fold_with(nfd, true, true));
        // Without normalization (Windows, Linux) they are different names.
        assert_ne!(fold_with(nfc, true, false), fold_with(nfd, true, false));
        assert_ne!(fold_with(nfc, false, false), fold_with(nfd, false, false));
        // Case-sensitive systems keep case.
        assert_ne!(fold_with("A", false, false), fold_with("a", false, false));
        if CASE_INSENSITIVE {
            let mut t = LocalTree::default();
            assert!(t.claim(&local_components("\u{3a3}\u{3a3}.txt"), "p/1").is_ok());
            assert!(t.claim(&local_components("\u{3c3}\u{3c3}.txt"), "p/2").is_err(), "sigma pair collides");
        }
    }

    #[test]
    fn collisions_are_detected_first_key_wins() {
        let mut t = LocalTree::default();
        assert!(t.claim(&local_components("A.txt"), "p/A.txt").is_ok());
        let second = t.claim(&local_components("a.txt"), "p/a.txt");
        if CASE_INSENSITIVE {
            assert_eq!(second, Err(Collision::SameFile { other: "p/A.txt".into() }));
        } else {
            assert!(second.is_ok());
        }
        // Different keys that sanitize to the same name.
        assert!(t.claim(&local_components("x:y"), "p/x:y").is_ok());
        assert_eq!(t.claim(&local_components("x?y"), "p/x?y"), Err(Collision::SameFile { other: "p/x:y".into() }));
        assert_eq!(t.claim(&local_components("x_y"), "p/x_y"), Err(Collision::SameFile { other: "p/x:y".into() }));
        // Trailing dot / space variants.
        assert!(t.claim(&local_components("n"), "p/n").is_ok());
        assert!(t.claim(&local_components("n."), "p/n.").is_err());
        assert!(t.claim(&local_components("n "), "p/n ").is_err());
        // a//b and a/_/b are the same local file.
        assert!(t.claim(&local_components("a//b"), "p/a//b").is_ok());
        assert_eq!(t.claim(&local_components("a/_/b"), "p/a/_/b"), Err(Collision::SameFile { other: "p/a//b".into() }));
        // A file where a folder is needed, and the other way round.
        assert!(t.claim(&local_components("d/e.txt"), "p/d/e.txt").is_ok());
        assert_eq!(t.claim(&local_components("d"), "p/d"), Err(Collision::IsFolderOf { other: "p/d/e.txt".into() }));
        assert!(t.claim(&local_components("f"), "p/f").is_ok());
        assert_eq!(t.claim(&local_components("f/g.txt"), "p/f/g.txt"), Err(Collision::UnderFileOf { other: "p/f".into() }));
        // A refused key claimed nothing: its folder is still free for a file.
        assert!(t.claim(&local_components("f2/g"), "p/f2/g").is_ok());
        // Siblings are fine.
        assert!(t.claim(&local_components("d/e2.txt"), "p/d/e2.txt").is_ok());
        let msg = Collision::SameFile { other: "p/A.txt".into() }.message("D:\\dl\\a.txt");
        assert!(msg.contains("p/A.txt") && msg.contains("D:\\dl\\a.txt"), "{msg}");
    }
}
