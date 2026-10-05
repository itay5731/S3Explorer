//! Plain S3 operations (no Tauri dependency) used by the commands and the smoke test.

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;

use crate::error::{AppError, AppResult};
use crate::models::{
    clean_etag, fmt_dt, last_segment, Bucket, FolderEntry, ListPage, ObjectEntry, ObjectMeta,
};

pub async fn list_buckets(client: &Client) -> AppResult<Vec<Bucket>> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let resp = client.list_buckets().set_continuation_token(token.clone()).send().await?;
        out.extend(resp.buckets().iter().map(|b| Bucket {
            name: b.name().unwrap_or_default().to_string(),
            creation_date: fmt_dt(b.creation_date()),
        }));
        match resp.continuation_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn list_objects(
    client: &Client,
    bucket: &str,
    prefix: &str,
    continuation_token: Option<String>,
    page_size: Option<i32>,
) -> AppResult<ListPage> {
    let page_size = page_size.filter(|n| *n > 0).unwrap_or(1000).min(1000);
    let resp = client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .delimiter("/")
        .max_keys(page_size)
        .set_continuation_token(continuation_token.filter(|t| !t.is_empty()))
        .send()
        .await?;

    let folders = resp
        .common_prefixes()
        .iter()
        .filter_map(|cp| cp.prefix())
        .map(|p| FolderEntry { prefix: p.to_string(), name: last_segment(p) })
        .collect();

    let objects = resp
        .contents()
        .iter()
        .filter_map(|o| {
            let key = o.key()?;
            if key == prefix {
                return None; // folder marker
            }
            Some(ObjectEntry {
                key: key.to_string(),
                name: last_segment(key),
                size: o.size().unwrap_or(0).max(0) as u64,
                last_modified: fmt_dt(o.last_modified()),
                etag: clean_etag(o.e_tag()),
                storage_class: o.storage_class().map(|s| s.as_str().to_string()),
            })
        })
        .collect();

    let is_truncated = resp.is_truncated().unwrap_or(false);
    Ok(ListPage {
        folders,
        objects,
        next_continuation_token: if is_truncated { resp.next_continuation_token().map(str::to_string) } else { None },
        is_truncated,
    })
}

pub async fn head_object(client: &Client, bucket: &str, key: &str) -> AppResult<ObjectMeta> {
    if key.is_empty() {
        return Err(AppError::invalid("Object key is required"));
    }
    let h = client.head_object().bucket(bucket).key(key).send().await?;
    Ok(ObjectMeta {
        key: key.to_string(),
        name: last_segment(key),
        size: h.content_length().unwrap_or(0).max(0) as u64,
        last_modified: fmt_dt(h.last_modified()),
        etag: clean_etag(h.e_tag()),
        storage_class: Some(h.storage_class().map(|s| s.as_str().to_string()).unwrap_or_else(|| "STANDARD".into())),
        content_type: h.content_type().map(str::to_string),
        metadata: h.metadata().cloned().unwrap_or_default(),
        version_id: h.version_id().map(str::to_string),
    })
}

/// Folder prefixes are used exactly as given (S3 keys may legitimately contain "//" or a
/// leading "/"); only a missing trailing '/' is appended. Nothing else is rewritten.
fn folder_prefix(prefix: &str) -> AppResult<String> {
    if prefix.is_empty() || prefix == "/" {
        return Err(AppError::invalid("Folder prefix is required"));
    }
    Ok(if prefix.ends_with('/') { prefix.to_string() } else { format!("{prefix}/") })
}

pub async fn create_folder(client: &Client, bucket: &str, prefix: &str) -> AppResult<()> {
    let prefix = folder_prefix(prefix)?;
    client
        .put_object()
        .bucket(bucket)
        .key(prefix)
        .content_length(0)
        .body(ByteStream::from_static(b""))
        .send()
        .await?;
    Ok(())
}

/// Lists every key under `prefix` (no delimiter).
pub async fn list_all_keys(client: &Client, bucket: &str, prefix: &str) -> AppResult<Vec<String>> {
    let mut keys = Vec::new();
    let mut pages = client.list_objects_v2().bucket(bucket).prefix(prefix).into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page?;
        keys.extend(page.contents().iter().filter_map(|o| o.key().map(str::to_string)));
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::folder_prefix;

    #[test]
    fn folder_prefix_is_never_normalized() {
        assert_eq!(folder_prefix("a/").unwrap(), "a/");
        assert_eq!(folder_prefix("a").unwrap(), "a/");
        assert_eq!(folder_prefix("a//").unwrap(), "a//");
        assert_eq!(folder_prefix("/foo/").unwrap(), "/foo/");
        assert_eq!(folder_prefix("a/b c/ü/").unwrap(), "a/b c/ü/");
        assert!(folder_prefix("").is_err());
        assert!(folder_prefix("/").is_err());
    }
}
