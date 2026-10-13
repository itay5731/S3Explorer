//! `preview_object`: the first bytes of a text file or a whole small image, read into memory so
//! the UI can show what is inside without a download. See "Object preview" in docs/CONTRACT.md.

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::Client;

use crate::archive::ArchiveInfo;
use crate::error::{AppError, AppResult, ErrorCode, ARCHIVED};
use crate::models::{ObjectPreview, PreviewKind};
use crate::transfers::{next_chunk, upload_attempt_timeout};

/// `PREVIEW_LIMITS.textMaxBytes`: at most this much of a text file is read.
pub const PREVIEW_TEXT_MAX: u64 = 262_144;
/// `PREVIEW_LIMITS.imageMaxBytes`: larger images are not previewed.
pub const PREVIEW_IMAGE_MAX: u64 = 10_485_760;
/// An object of unknown kind is text if its first bytes are.
const SNIFF_BYTES: u64 = 8 * 1024;

pub const REASON_ARCHIVED: &str = "Archived: restore it to preview";
pub const REASON_BINARY: &str = "Binary file";
pub const REASON_TOO_LARGE: &str = "Too large to preview";

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"];
const IMAGE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/avif",
    "image/svg+xml",
];
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "yaml", "yml", "toml", "ini", "conf", "cfg",
    "env", "sql", "sh", "bat", "ps1", "py", "js", "mjs", "ts", "tsx", "jsx", "css", "scss", "html", "htm", "rs", "go",
    "java", "kt", "c", "h", "cpp", "cs", "rb", "php", "swift", "tf", "hcl", "properties", "gitignore", "dockerfile",
];
const TEXT_TYPES: &[&str] = &["application/json", "application/xml", "application/x-yaml"];

/// What the key and content type say about an object, before any byte is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detected {
    Image,
    Text,
    /// Neither: decided by [`looks_like_text`] on the first [`SNIFF_BYTES`].
    Sniff,
}

/// The extension (lowercase) of the key's last segment; a dotless `Dockerfile` counts as its own
/// extension so it is recognized by name.
fn extension(key: &str) -> Option<String> {
    let name = key.rsplit('/').next().unwrap_or(key).to_ascii_lowercase();
    match name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => Some(ext.to_string()),
        None if name == "dockerfile" => Some(name),
        _ => None,
    }
}

pub fn detect(key: &str, content_type: Option<&str>) -> Detected {
    let ext = extension(key);
    let ext = ext.as_deref();
    let mime = content_type.map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase());
    let mime = mime.as_deref();
    if ext.is_some_and(|e| IMAGE_EXTENSIONS.contains(&e)) {
        Detected::Image
    } else if ext.is_some_and(|e| TEXT_EXTENSIONS.contains(&e)) {
        Detected::Text
    } else if mime.is_some_and(|m| IMAGE_TYPES.contains(&m)) {
        Detected::Image
    } else if mime.is_some_and(|m| m.starts_with("text/") || TEXT_TYPES.contains(&m)) {
        Detected::Text
    } else {
        Detected::Sniff
    }
}

/// Number of trailing bytes of `b` that start a multi-byte UTF-8 character but do not finish it
/// (a read that stopped mid-character), 0 if the end is complete.
fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let c = b[b.len() - back];
        if c & 0xC0 == 0x80 {
            continue; // continuation byte: keep looking for the lead byte
        }
        let need = match c {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

/// Valid UTF-8 without NUL bytes. `cut`: the sample is a prefix of a longer object, so a character
/// split at its end is allowed.
pub fn looks_like_text(sample: &[u8], cut: bool) -> bool {
    if sample.contains(&0) {
        return false;
    }
    let end = sample.len() - if cut { incomplete_tail(sample) } else { 0 };
    std::str::from_utf8(&sample[..end]).is_ok()
}

/// UTF-8 with invalid sequences replaced. When `truncated`, a character cut by the read limit is
/// dropped instead of showing up as a replacement character.
pub fn decode_text(bytes: &[u8], truncated: bool) -> String {
    let end = bytes.len() - if truncated { incomplete_tail(bytes) } else { 0 };
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// A response to `Range: bytes=0-{len-1}` must carry exactly `len` bytes starting at 0.
fn check_response(len: u64, content_length: Option<i64>, content_range: Option<&str>) -> AppResult<()> {
    let mismatch = |what: String| {
        AppError::new(ErrorCode::Unknown, format!("Server did not honor the byte range 0-{}: {what}", len - 1))
    };
    if let Some(n) = content_length {
        if n.max(0) as u64 != len {
            return Err(mismatch(format!("Content-Length {n}, expected {len}")));
        }
    }
    if let Some(cr) = content_range {
        if !cr.starts_with(&format!("bytes 0-{}/", len - 1)) {
            return Err(mismatch(format!("Content-Range {cr}")));
        }
    }
    Ok(())
}

fn unsupported(mut p: ObjectPreview, reason: &str) -> ObjectPreview {
    p.kind = PreviewKind::Unsupported;
    p.reason = Some(reason.to_string());
    p
}

struct Reader<'a> {
    client: &'a Client,
    bucket: &'a str,
    key: &'a str,
    etag: Option<&'a str>,
}

impl Reader<'_> {
    /// The first `len` bytes, in one ranged GET pinned to the ETag the HEAD saw. Body stalls are
    /// bounded like a download's; the whole read like a transfer request of that size.
    async fn read_prefix(&self, len: u64) -> AppResult<Vec<u8>> {
        if len == 0 {
            return Ok(Vec::new()); // never request an empty range
        }
        let read = async {
            let resp = self
                .client
                .get_object()
                .bucket(self.bucket)
                .key(self.key)
                .range(format!("bytes=0-{}", len - 1))
                .set_if_match(self.etag.map(str::to_string))
                .send()
                .await
                .map_err(|e| {
                    let status = e.raw_response().map(|r| r.status().as_u16());
                    if status == Some(412) || e.as_service_error().and_then(|s| s.code()) == Some("PreconditionFailed") {
                        AppError::new(ErrorCode::Conflict, "The object changed while it was read. Retry to preview the current version.")
                    } else {
                        AppError::from(e)
                    }
                })?;
            check_response(len, resp.content_length(), resp.content_range())?;
            let mut body = resp.body;
            let mut buf = Vec::with_capacity(len as usize);
            while let Some(chunk) = next_chunk(&mut body).await? {
                if (buf.len() + chunk.len()) as u64 > len {
                    return Err(AppError::new(ErrorCode::Unknown, format!("Server sent more than the {len} bytes asked for")));
                }
                buf.extend_from_slice(&chunk);
            }
            if buf.len() as u64 != len {
                return Err(AppError::new(ErrorCode::Network, format!("Short read: got {} of {len} bytes", buf.len())));
            }
            Ok(buf)
        };
        tokio::time::timeout(upload_attempt_timeout(len, 1), read)
            .await
            .map_err(|_| AppError::new(ErrorCode::Network, "Reading the preview timed out"))?
    }

    async fn text(&self, mut p: ObjectPreview) -> AppResult<ObjectPreview> {
        let n = p.size.min(PREVIEW_TEXT_MAX);
        let bytes = self.read_prefix(n).await?;
        p.truncated = p.size > n;
        p.text = Some(decode_text(&bytes, p.truncated));
        p.kind = PreviewKind::Text;
        Ok(p)
    }

    async fn build(&self, detected: Detected, mut p: ObjectPreview) -> AppResult<ObjectPreview> {
        match detected {
            Detected::Image if p.size > PREVIEW_IMAGE_MAX => Ok(unsupported(p, REASON_TOO_LARGE)),
            Detected::Image => {
                let bytes = self.read_prefix(p.size).await?;
                p.data_base64 = Some(aws_smithy_types::base64::encode(&bytes));
                p.kind = PreviewKind::Image;
                Ok(p)
            }
            Detected::Text => self.text(p).await,
            Detected::Sniff => {
                let n = p.size.min(SNIFF_BYTES);
                let sample = self.read_prefix(n).await?;
                if !looks_like_text(&sample, p.size > n) {
                    Ok(unsupported(p, REASON_BINARY))
                } else if p.size <= n {
                    p.text = Some(decode_text(&sample, false));
                    p.kind = PreviewKind::Text;
                    Ok(p)
                } else {
                    self.text(p).await
                }
            }
        }
    }
}

pub async fn preview_object(client: &Client, bucket: &str, key: &str) -> AppResult<ObjectPreview> {
    if key.is_empty() || key.ends_with('/') {
        return Err(AppError::invalid("A file key is required"));
    }
    let h = client.head_object().bucket(bucket).key(key).send().await?;
    let p = ObjectPreview {
        kind: PreviewKind::Unsupported,
        content_type: h.content_type().map(str::to_string),
        size: h.content_length().unwrap_or(0).max(0) as u64,
        truncated: false,
        text: None,
        data_base64: None,
        reason: None,
    };
    if ArchiveInfo::from_head(&h).archived(chrono::Utc::now()) {
        return Ok(unsupported(p, REASON_ARCHIVED));
    }
    let reader = Reader { client, bucket, key, etag: h.e_tag() };
    let detected = detect(key, p.content_type.as_deref());
    match reader.build(detected, p.clone()).await {
        // The HEAD may not show the archive state (some servers); the GET's refusal decides.
        Err(e) if e.message == ARCHIVED => Ok(unsupported(p, REASON_ARCHIVED)),
        r => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_from_extension_and_content_type() {
        assert_eq!(detect("a/b/photo.PNG", None), Detected::Image);
        assert_eq!(detect("logo.svg", Some("text/plain")), Detected::Image, "an image extension wins");
        assert_eq!(detect("x/data.json", Some("application/octet-stream")), Detected::Text);
        assert_eq!(detect("notes.MD", None), Detected::Text);
        assert_eq!(detect("dir/.gitignore", None), Detected::Text);
        assert_eq!(detect("app/Dockerfile", None), Detected::Text);
        assert_eq!(detect("app/dockerfile.bak", None), Detected::Sniff);
        assert_eq!(detect("noext", Some("image/jpeg")), Detected::Image);
        assert_eq!(detect("noext", Some("Text/CSV; charset=utf-8")), Detected::Text);
        assert_eq!(detect("blob.bin", Some("application/json")), Detected::Text);
        assert_eq!(detect("blob.bin", Some("application/x-yaml")), Detected::Text);
        assert_eq!(detect("blob.bin", Some("application/octet-stream")), Detected::Sniff);
        assert_eq!(detect("archive.tar.gz", None), Detected::Sniff);
        assert_eq!(detect("trailingdot.", None), Detected::Sniff);
        assert_eq!(detect("dir.png/file", None), Detected::Sniff, "only the last segment counts");
        assert_eq!(detect("pic.tiff", Some("image/tiff")), Detected::Sniff, "not a listed image type");
    }

    #[test]
    fn sniffing_needs_utf8_without_nul() {
        assert!(looks_like_text(b"hello\nworld", false));
        assert!(looks_like_text("h\u{e9}llo \u{1F600}".as_bytes(), false));
        assert!(looks_like_text(b"", false));
        assert!(!looks_like_text(b"hel\0lo", false));
        assert!(!looks_like_text(b"\x89PNG\r\n\x1a\n", false));
        assert!(!looks_like_text(b"ok \xff\xfe bad", true));
        // A character cut at the end of the sample: fine only when the object continues.
        let emoji = "ab\u{1F600}".as_bytes();
        for cut in 3..emoji.len() {
            assert!(looks_like_text(&emoji[..cut], true), "cut at {cut}");
            assert!(!looks_like_text(&emoji[..cut], false), "cut at {cut} of a complete object");
        }
        assert!(!looks_like_text(b"ab\x80", true), "a stray continuation byte is not a cut character");
    }

    #[test]
    fn decoding_drops_only_a_cut_tail() {
        let s = "x\u{e9}\u{20AC}".as_bytes(); // 1 + 2 + 3 bytes
        assert_eq!(decode_text(&s[..s.len() - 1], true), "x\u{e9}");
        assert_eq!(decode_text(&s[..2], true), "x");
        assert_eq!(decode_text(s, true), "x\u{e9}\u{20AC}");
        assert_eq!(decode_text(&s[..2], false), "x\u{FFFD}", "a complete object keeps the replacement");
        assert_eq!(decode_text(b"a\xffb", true), "a\u{FFFD}b");
    }

    #[test]
    fn ranged_response_must_match() {
        assert!(check_response(10, Some(10), Some("bytes 0-9/100")).is_ok());
        assert!(check_response(10, Some(10), None).is_ok());
        assert!(check_response(10, Some(100), None).is_err(), "server ignored Range");
        assert!(check_response(10, Some(5), Some("bytes 0-4/5")).is_err(), "short");
        assert!(check_response(10, Some(10), Some("bytes 5-14/100")).is_err(), "wrong offset");
    }
}
