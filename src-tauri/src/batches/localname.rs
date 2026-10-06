//! Local file names for S3 keys (folder downloads), and the check that two keys never end up in
//! the same local file.
//!
//! S3 keys are opaque: a segment may hold `\`, `:`, `..`, control characters or a Windows
//! reserved name, and two different keys can map to one local path once sanitized (or, on a
//! case-insensitive disk, by case alone). The rule here is the frontend's `sanitizeFileName`
//! (`src/lib/format.ts`), applied to every segment of the key below the batch prefix.

use std::collections::HashMap;

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

/// `^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$`, case-insensitive (ASCII), as in the frontend.
fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    match stem.as_bytes() {
        b"con" | b"prn" | b"aux" | b"nul" => true,
        [b'c', b'o', b'm', d] | [b'l', b'p', b't', d] => (b'1'..=b'9').contains(d),
        _ => false,
    }
}

/// The local path components for `rel` (a key with the batch prefix removed): split on `/` and
/// every segment sanitized, so `a//b` becomes `a/_/b`. The key itself is never changed.
pub fn local_components(rel: &str) -> Vec<String> {
    rel.split('/').map(sanitize_segment).collect()
}

/// Whether local paths compare without case on this OS (Windows and macOS by default).
const CASE_INSENSITIVE: bool = cfg!(any(windows, target_os = "macos"));

fn fold(path: &str) -> String {
    if CASE_INSENSITIVE {
        path.to_lowercase()
    } else {
        path.to_string()
    }
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
