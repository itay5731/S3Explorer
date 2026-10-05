//! Test-only helpers: a tiny scripted HTTP/1.1 server that stands in for S3, and a client for it.
//!
//! The server reads each request completely (head and `Content-Length` body, answering
//! `Expect: 100-continue`), records it, and does whatever the handler says: answer, send part of
//! a body and drop the connection, or never answer. No external tools, no real S3.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use aws_credential_types::Credentials;
use aws_sdk_s3::config::retry::RetryConfig;
use aws_sdk_s3::config::timeout::TimeoutConfig;
use aws_sdk_s3::config::{BehaviorVersion, Region, RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::Client;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    /// Path without the query, e.g. `/bucket/key`.
    pub path: String,
    /// Raw query string (without `?`).
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn has_query(&self, name: &str) -> bool {
        self.query.split('&').any(|p| p == name || p.starts_with(&format!("{name}=")))
    }
    /// Every `<Key>` value in an XML body (test keys are plain ASCII).
    pub fn xml_keys(&self) -> Vec<String> {
        let b = String::from_utf8_lossy(&self.body);
        b.split("<Key>").skip(1).filter_map(|s| s.split("</Key>").next()).map(str::to_string).collect()
    }
}

pub enum Reply {
    /// A complete response (`Content-Length` is added).
    Full { status: u16, headers: Vec<(String, String)>, body: Vec<u8> },
    /// Status and headers as given (they should announce more than `body`), then `body`, then
    /// the connection is closed.
    Partial { status: u16, headers: Vec<(String, String)>, body: Vec<u8> },
    /// Read the request, then never answer (the connection stays open).
    Hang,
}

impl Reply {
    pub fn xml(status: u16, body: &str) -> Self {
        Reply::Full { status, headers: vec![h("Content-Type", "application/xml")], body: body.as_bytes().to_vec() }
    }
    pub fn status(status: u16) -> Self {
        Reply::Full { status, headers: vec![], body: vec![] }
    }
    pub fn with_headers(status: u16, headers: Vec<(String, String)>) -> Self {
        Reply::Full { status, headers, body: vec![] }
    }
}

pub fn h(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

type Handler = Arc<dyn Fn(&Req) -> Reply + Send + Sync>;

pub struct FakeS3 {
    pub endpoint: String,
    pub requests: Arc<Mutex<Vec<Req>>>,
}

impl FakeS3 {
    pub async fn start(handler: impl Fn(&Req) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let endpoint = format!("http://{}", listener.local_addr().expect("addr"));
        let requests: Arc<Mutex<Vec<Req>>> = Arc::default();
        let handler: Handler = Arc::new(handler);
        let log = requests.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(serve(sock, handler.clone(), log.clone()));
            }
        });
        Self { endpoint, requests }
    }

    pub fn requests(&self) -> Vec<Req> {
        self.requests.lock().map(|v| v.clone()).unwrap_or_default()
    }

    pub fn count(&self, pred: impl Fn(&Req) -> bool) -> usize {
        self.requests().iter().filter(|r| pred(r)).count()
    }

    /// A client like the app's for a custom endpoint (path style, checksums only when
    /// required, 10 s connect / 30 s read timeouts, standard retries with 3 attempts).
    pub fn client(&self) -> Client {
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new("test", "test", None, None, "test"))
            .endpoint_url(&self.endpoint)
            .force_path_style(true)
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .retry_config(RetryConfig::standard().with_max_attempts(3).with_initial_backoff(Duration::from_millis(50)))
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(30))
                    .build(),
            )
            .build();
        Client::from_conf(conf)
    }
}

async fn read_request(sock: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Req> {
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let mut tmp = [0u8; 8192];
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    buf.drain(..head_end + 4);
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect();
    let get = |n: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.clone());
    if get("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
        sock.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.ok()?;
    }
    let len: usize = get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    while buf.len() < len {
        let mut tmp = [0u8; 65536];
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body: Vec<u8> = buf.drain(..len).collect();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    Some(Req { method, path, query, headers, body })
}

fn head_bytes(status: u16, headers: &[(String, String)], content_length: Option<usize>) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status} Fake\r\n");
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(n) = content_length {
        out.push_str(&format!("Content-Length: {n}\r\n"));
    }
    out.push_str("\r\n");
    out.into_bytes()
}

async fn serve(mut sock: TcpStream, handler: Handler, log: Arc<Mutex<Vec<Req>>>) {
    let mut buf = Vec::new();
    while let Some(req) = read_request(&mut sock, &mut buf).await {
        let reply = handler(&req);
        let is_head = req.method == "HEAD";
        if let Ok(mut v) = log.lock() {
            v.push(req);
        }
        match reply {
            Reply::Full { status, headers, body } => {
                let has_len = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-length"));
                let mut out = head_bytes(status, &headers, if has_len { None } else { Some(body.len()) });
                if !is_head {
                    out.extend_from_slice(&body);
                }
                if sock.write_all(&out).await.is_err() {
                    return;
                }
            }
            Reply::Partial { status, headers, body } => {
                let mut out = head_bytes(status, &headers, None);
                out.extend_from_slice(&body);
                let _ = sock.write_all(&out).await;
                let _ = sock.flush().await;
                return; // drop = close
            }
            Reply::Hang => {
                // Keep the socket open and silent until the client gives up.
                let mut sink = [0u8; 1024];
                while let Ok(n) = sock.read(&mut sink).await {
                    if n == 0 {
                        break;
                    }
                }
                return;
            }
        }
    }
}

/// A scratch directory under `src-tauri/target/` (test data stays on this drive), removed on drop.
pub struct ScratchDir(pub std::path::PathBuf);

impl ScratchDir {
    pub fn new(tag: &str) -> Self {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-scratch")
            .join(format!("{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).expect("scratch dir");
        Self(p)
    }
    pub fn files(&self) -> Vec<String> {
        std::fs::read_dir(&self.0)
            .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
