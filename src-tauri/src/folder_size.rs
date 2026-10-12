//! `folder_size`: how many objects and bytes are under a prefix, from a bounded flat listing.

use std::collections::HashSet;
use std::future::Future;

use aws_sdk_s3::Client;
use tokio::sync::Semaphore;

use crate::error::{AppError, AppResult};
use crate::models::{FolderSize, FOLDER_SIZE_MAX_PAGES, FOLDER_SIZE_PARALLEL_SCANS, FOLDER_SIZE_SCAN_LIMIT};
use crate::ops::{listing_error, next_list_page, NextPage};
use crate::search::SearchRegistry;

/// Counts every key under `prefix` (sent verbatim, no delimiter), page by page, stopping after
/// [`FOLDER_SIZE_SCAN_LIMIT`] keys or [`FOLDER_SIZE_MAX_PAGES`] pages.
pub async fn folder_size(client: &Client, bucket: &str, prefix: &str) -> AppResult<FolderSize> {
    scan(client, bucket, prefix, FOLDER_SIZE_SCAN_LIMIT, FOLDER_SIZE_MAX_PAGES).await
}

async fn scan(client: &Client, bucket: &str, prefix: &str, limit: u64, max_pages: u64) -> AppResult<FolderSize> {
    if bucket.trim().is_empty() {
        return Err(AppError::invalid("Bucket name is required"));
    }
    let mut out = FolderSize::default();
    let mut token: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    let mut pages: u64 = 0;
    loop {
        // Never ask for more than is left, so the limit is met exactly.
        let room = (limit - out.scanned).min(1000) as i32;
        let page = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .max_keys(room)
            .set_continuation_token(token.clone())
            .send()
            .await?;
        pages += 1;
        // Keys of this page a server that ignores MaxKeys sent past the limit.
        let mut left_over = false;
        for o in page.contents() {
            if o.key().is_none() {
                continue;
            }
            if out.scanned >= limit {
                left_over = true;
                break;
            }
            out.scanned += 1;
            // A folder marker is not an object.
            if o.key().is_some_and(|k| k.ends_with('/')) {
                continue;
            }
            out.objects += 1;
            out.bytes = out.bytes.saturating_add(o.size().unwrap_or(0).max(0) as u64);
        }
        match next_list_page(page.is_truncated(), page.next_continuation_token(), |t| seen.contains(t)) {
            NextPage::Done => {
                out.truncated = left_over;
                return Ok(out);
            }
            // More pages exist: stopping now is a lower bound, never a complete count.
            NextPage::Continue(_) if out.scanned >= limit || pages >= max_pages => {
                out.truncated = true;
                return Ok(out);
            }
            NextPage::Continue(t) => {
                seen.insert(t.clone());
                token = Some(t);
            }
            NextPage::Error(why) => return Err(listing_error(bucket, prefix, why)),
        }
    }
}

/// Running `folder_size` scans by caller-chosen id, at most [`FOLDER_SIZE_PARALLEL_SCANS`] at once.
pub struct FolderSizeScans {
    /// Same id rules as searches: a newer call with the id cancels the older, `cancel` names one.
    running: SearchRegistry,
    slots: Semaphore,
}

impl Default for FolderSizeScans {
    fn default() -> Self {
        Self { running: SearchRegistry::new(), slots: Semaphore::new(FOLDER_SIZE_PARALLEL_SCANS) }
    }
}

impl FolderSizeScans {
    pub fn new() -> Self {
        Self::default()
    }

    /// Waits for a slot, resolves the bucket's client and scans; all of it cancellable under `id`.
    pub async fn run<F, Fut>(&self, id: &str, bucket: &str, prefix: &str, client: F) -> AppResult<FolderSize>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = AppResult<Client>>,
    {
        self.running
            .run(id, async {
                let _slot = self.slots.acquire().await.map_err(|_| AppError::cancelled())?;
                let c = client().await?;
                folder_size(&c, bucket, prefix).await
            })
            .await
    }

    /// `cancel_folder_size`: the scan with this id ends `Cancelled`; unknown id is a no-op.
    pub fn cancel(&self, id: &str) {
        self.running.cancel(id);
    }

    /// Disconnect or a new connection: every scan belongs to the old one.
    pub fn cancel_all(&self) {
        self.running.cancel_all();
    }

    /// Scans registered (running or waiting for a slot).
    pub fn running(&self) -> usize {
        self.running.running()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::testutil::{FakeS3, Reply};
    use std::sync::Arc;
    use std::time::Duration;

    fn param(query: &str, name: &str) -> Option<String> {
        query.split('&').find_map(|p| p.strip_prefix(&format!("{name}=")).map(str::to_string))
    }

    /// A server holding `keys` (key, size) that honours `max-keys`, sends at most `page` keys per
    /// page and uses the index as the continuation token.
    fn bucket_of(keys: Vec<(&'static str, u64)>, page: usize) -> impl Fn(&crate::testutil::Req) -> Reply {
        move |r| {
            let start: usize = param(&r.query, "continuation-token").and_then(|t| t.parse().ok()).unwrap_or(0);
            let max: usize = param(&r.query, "max-keys").and_then(|t| t.parse().ok()).unwrap_or(1000).min(page);
            let prefix = param(&r.query, "prefix").unwrap_or_default().replace("%2F", "/");
            let all: Vec<&(&str, u64)> = keys.iter().filter(|(k, _)| k.starts_with(prefix.as_str())).collect();
            let end = (start + max).min(all.len());
            let mut x = format!("<ListBucketResult><IsTruncated>{}</IsTruncated>", end < all.len());
            if end < all.len() {
                x.push_str(&format!("<NextContinuationToken>{end}</NextContinuationToken>"));
            }
            for (k, s) in &all[start..end] {
                x.push_str(&format!("<Contents><Key>{k}</Key><Size>{s}</Size></Contents>"));
            }
            x.push_str("</ListBucketResult>");
            Reply::xml(200, &x)
        }
    }

    fn sample() -> Vec<(&'static str, u64)> {
        vec![
            ("docs/", 0),
            ("docs/a.txt", 10),
            ("docs/sub/", 0),
            ("docs/sub/b.bin", 1000),
            ("docs/sub/c", 5),
            ("docsx/other", 7),
        ]
    }

    #[tokio::test]
    async fn markers_are_listed_but_not_counted() {
        let fake = FakeS3::start(bucket_of(sample(), 1000)).await;
        let s = scan(&fake.client(), "b", "docs/", 100, 100).await.expect("size");
        assert_eq!(s, FolderSize { objects: 3, bytes: 1015, scanned: 5, truncated: false });
        assert!(fake.requests().iter().all(|r| !r.has_query("delimiter")), "a flat listing");
    }

    #[tokio::test]
    async fn pages_are_followed_to_the_end() {
        let fake = FakeS3::start(bucket_of(sample(), 2)).await;
        let s = scan(&fake.client(), "b", "docs/", 1000, 100).await.expect("size");
        assert_eq!(s, FolderSize { objects: 3, bytes: 1015, scanned: 5, truncated: false });
        assert_eq!(fake.count(|_| true), 3, "pages of 2, 2 and 1");
        // Reaching the limit exactly on the last page is complete, not truncated.
        let s = scan(&fake.client(), "b", "", 6, 100).await.expect("size");
        assert_eq!(s, FolderSize { objects: 4, bytes: 1022, scanned: 6, truncated: false });
    }

    #[tokio::test]
    async fn stopping_at_the_limit_is_truncated_and_asks_for_no_more() {
        let fake = FakeS3::start(bucket_of(sample(), 1000)).await;
        let s = scan(&fake.client(), "b", "docs/", 3, 100).await.expect("size");
        assert_eq!(s, FolderSize { objects: 1, bytes: 10, scanned: 3, truncated: true });
        let maxes: Vec<String> = fake.requests().iter().filter_map(|r| param(&r.query, "max-keys")).collect();
        assert_eq!(maxes, ["3"], "one page, no larger than the limit");
    }

    #[tokio::test]
    async fn the_page_bound_truncates() {
        let fake = FakeS3::start(|r| {
            let n: u64 = param(&r.query, "continuation-token").and_then(|t| t.parse().ok()).unwrap_or(0);
            Reply::xml(
                200,
                &format!(
                    "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>{}</NextContinuationToken><Contents><Key>m{n}/</Key><Size>0</Size></Contents></ListBucketResult>",
                    n + 1
                ),
            )
        })
        .await;
        let s = scan(&fake.client(), "b", "", 1000, 4).await.expect("size");
        assert_eq!(s, FolderSize { objects: 0, bytes: 0, scanned: 4, truncated: true });
        assert_eq!(fake.count(|_| true), 4);
    }

    #[tokio::test]
    async fn a_server_ignoring_max_keys_is_truncated_at_the_limit() {
        let fake = FakeS3::start(|_| {
            Reply::xml(200, "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><Size>1</Size></Contents><Contents><Key>b</Key><Size>2</Size></Contents><Contents><Key>c</Key><Size>4</Size></Contents></ListBucketResult>")
        })
        .await;
        let s = scan(&fake.client(), "b", "", 2, 100).await.expect("size");
        assert_eq!(s, FolderSize { objects: 2, bytes: 3, scanned: 2, truncated: true });
        let s = scan(&fake.client(), "b", "", 3, 100).await.expect("size");
        assert_eq!(s, FolderSize { objects: 3, bytes: 7, scanned: 3, truncated: false });
    }

    #[tokio::test]
    async fn a_repeated_token_or_a_missing_one_is_an_error_not_a_total() {
        let fake = FakeS3::start(|_| {
            Reply::xml(200, "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken><Contents><Key>a</Key><Size>1</Size></Contents></ListBucketResult>")
        })
        .await;
        assert!(scan(&fake.client(), "b", "", 1000, 100).await.is_err());
        let fake = FakeS3::start(|_| {
            Reply::xml(200, "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a</Key><Size>1</Size></Contents></ListBucketResult>")
        })
        .await;
        assert!(scan(&fake.client(), "b", "", 1000, 100).await.is_err());
    }

    #[tokio::test]
    async fn at_most_four_run_and_cancel_stops_running_and_waiting_scans() {
        let fake = Arc::new(FakeS3::start(|_| Reply::Hang).await);
        let scans = Arc::new(FolderSizeScans::new());
        let mut tasks = Vec::new();
        for i in 0..5 {
            let (scans, fake) = (scans.clone(), fake.clone());
            tasks.push(tokio::spawn(async move {
                let client = fake.client();
                scans.run(&format!("s{i}"), "b", "p/", || async move { Ok(client) }).await
            }));
        }
        let wait = async {
            while fake.count(|_| true) < 4 || scans.running() < 5 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), wait).await.expect("four requests");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fake.count(|_| true), 4, "the fifth waits for a slot");

        // Cancelling a waiting scan, then an unknown id (no-op), then the rest.
        scans.cancel("s4");
        scans.cancel("nope");
        let r = tokio::time::timeout(Duration::from_secs(5), tasks.pop().expect("task")).await.expect("ended").expect("join");
        assert_eq!(r.map_err(|e| e.code), Err(ErrorCode::Cancelled));
        scans.cancel_all();
        for t in tasks {
            let r = tokio::time::timeout(Duration::from_secs(5), t).await.expect("ended").expect("join");
            assert_eq!(r.map_err(|e| e.code), Err(ErrorCode::Cancelled));
        }
        assert_eq!(scans.running(), 0);
        assert_eq!(fake.count(|_| true), 4, "the cancelled waiter never listed");
    }
}
