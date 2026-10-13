//! Pause and resume (see "Pause and resume transfers" in docs/CONTRACT.md), against a scripted
//! fake S3 that holds chosen requests open until the client drops them.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;
use crate::batches::{BatchManager, NoopBatchSink};
use crate::models::{BatchKind, BatchPlanRequest, BatchStatus, ConflictPolicy};
use crate::testutil::{h, FakeS3, Reply, Req, ScratchDir};

const LIMIT: Duration = Duration::from_secs(30);

fn manager(settings: TransferSettings, sink: Arc<dyn ProgressSink>) -> Arc<TransferManager> {
    TransferManager::with_settings(sink, settings)
}

fn ranged_settings(parallel: u32) -> TransferSettings {
    TransferSettings { part_size_mib: Some(1), max_concurrent_parts: parallel, ..TransferSettings::default() }
}

async fn until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + LIMIT;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn status_is(tm: &TransferManager, id: &str, status: TransferStatus) {
    until(&format!("{id} {status:?}"), || tm.get(id).is_some_and(|t| t.status == status)).await;
}

async fn finished(tm: &TransferManager, id: &str) -> Transfer {
    tokio::time::timeout(LIMIT, tm.wait(id)).await.expect("finished in time").expect("known")
}

fn expected(size: u64) -> Vec<u8> {
    (0..size).map(|i| (i % 251) as u8).collect()
}

/// What the fake object looks like now; tests change it between pause and resume.
struct Object {
    size: u64,
    etag: Option<String>,
    last_modified: String,
    /// GETs whose range starts at or after this offset are held open (never answered).
    hold_from: u64,
}

/// Serves `object` (byte i = i % 251) and answers `If-Match` like S3 (412 when it differs).
async fn object_server(object: Arc<Mutex<Object>>) -> FakeS3 {
    FakeS3::start(move |r: &Req| {
        let o = object.lock().unwrap();
        let mut hs = vec![h("Last-Modified", &o.last_modified)];
        if let Some(e) = &o.etag {
            hs.push(h("ETag", e));
        }
        match r.method.as_str() {
            "HEAD" => {
                hs.push(h("Content-Length", &o.size.to_string()));
                Reply::with_headers(200, hs)
            }
            "GET" => {
                if let (Some(want), Some(have)) = (r.header("if-match"), o.etag.as_deref()) {
                    if want != have {
                        return Reply::xml(
                            412,
                            "<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>",
                        );
                    }
                }
                let (status, a, b) = match r.header("range").and_then(|v| v.strip_prefix("bytes=")) {
                    Some(spec) => {
                        let (a, b) = spec.split_once('-').expect("range");
                        (206, a.parse::<u64>().expect("a"), b.parse::<u64>().expect("b"))
                    }
                    None => (200, 0, o.size - 1),
                };
                if a >= o.hold_from {
                    return Reply::Hang;
                }
                if status == 206 {
                    hs.push(h("Content-Range", &format!("bytes {a}-{b}/{}", o.size)));
                }
                Reply::Full { status, headers: hs, body: (a..=b).map(|i| (i % 251) as u8).collect() }
            }
            _ => Reply::status(500),
        }
    })
    .await
}

fn range_starts(reqs: &[Req]) -> Vec<u64> {
    reqs.iter()
        .filter(|r| r.method == "GET")
        .filter_map(|r| r.header("range")?.strip_prefix("bytes=")?.split_once('-')?.0.parse().ok())
        .collect()
}

/// Starts an 8 MiB download in 1 MiB parts, two at a time, whose parts from 2 MiB on are held:
/// returns once parts 0 and 1 are written and parts 2 and 3 are in flight.
async fn download_held_after_two_parts(tm: &Arc<TransferManager>, s3: &FakeS3, dest: PathBuf) -> String {
    let id = tm.start_download(s3.client(), "b", "k", dest).expect("start");
    until("two parts done and two held", || {
        tm.get(&id).is_some_and(|t| t.parts_done == 2) && range_starts(&s3.requests()).iter().filter(|a| **a >= 2 * MIB).count() == 2
    })
    .await;
    id
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_download_resumes_to_an_identical_file_fetching_only_the_missing_parts() {
    let dir = ScratchDir::new("pause-dl");
    let size = 8 * MIB;
    let object = Arc::new(Mutex::new(Object { size, etag: Some("\"v1\"".into()), last_modified: "Mon, 05 Oct 2026 10:00:00 GMT".into(), hold_from: 2 * MIB }));
    let s3 = object_server(object.clone()).await;
    let tm = manager(ranged_settings(2), Arc::new(NoopSink));
    let dest = dir.0.join("obj.bin");
    let id = download_held_after_two_parts(&tm, &s3, dest.clone()).await;

    tm.pause(&id).expect("pause");
    status_is(&tm, &id, TransferStatus::Paused).await;
    let t = tm.get(&id).expect("known");
    assert_eq!((t.transferred_bytes, t.parts_done, t.bytes_per_sec), (2 * MIB, 2, 0), "progress stays at the finished parts");
    assert_eq!(tm.running_count(), 0, "the slot is given back");
    assert!(tm.has_active(), "paused counts as active");
    assert!(tm.remove(&id).is_err(), "a paused transfer cannot be removed");
    tm.pause(&id).expect("pausing again is a no-op");
    let files = dir.files();
    assert!(files.len() == 1 && files[0].ends_with(".part"), "the temp file stays: {files:?}");
    // Another download to the same file is still refused.
    assert!(tm.start_download(s3.client(), "b", "k", dest.clone()).is_err());

    let before = s3.requests().len();
    object.lock().unwrap().hold_from = u64::MAX;
    tm.resume(&id).expect("resume");
    let t = finished(&tm, &id).await;
    assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
    assert_eq!(std::fs::read(&dest).expect("file"), expected(size), "byte-identical");
    assert_eq!(dir.files(), vec!["obj.bin".to_string()], "no temp file left");
    let after = &s3.requests()[before..];
    let mut starts = range_starts(after);
    starts.sort();
    assert_eq!(starts, (2..8).map(|i| i * MIB).collect::<Vec<_>>(), "only the missing parts, each once");
    assert!(s3.requests().iter().filter(|r| r.method == "GET").all(|r| r.header("if-match") == Some("\"v1\"")), "pinned by If-Match");
    assert_eq!(after.iter().filter(|r| r.method == "HEAD").count(), 0, "no new HeadObject with an ETag in hand");
    assert!(tm.pause(&id).is_err(), "a finished transfer cannot be paused");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_whose_object_changed_while_paused_fails_and_leaves_no_file() {
    for with_etag in [true, false] {
        let dir = ScratchDir::new("pause-dl-changed");
        let size = 8 * MIB;
        let etag = with_etag.then(|| "\"v1\"".to_string());
        let object = Arc::new(Mutex::new(Object { size, etag, last_modified: "Mon, 05 Oct 2026 10:00:00 GMT".into(), hold_from: 2 * MIB }));
        let s3 = object_server(object.clone()).await;
        let tm = manager(ranged_settings(2), Arc::new(NoopSink));
        let dest = dir.0.join("obj.bin");
        std::fs::write(&dest, b"previous version").expect("existing file");
        let id = download_held_after_two_parts(&tm, &s3, dest.clone()).await;
        tm.pause(&id).expect("pause");
        status_is(&tm, &id, TransferStatus::Paused).await;
        {
            let mut o = object.lock().unwrap();
            o.hold_from = u64::MAX;
            o.last_modified = "Mon, 05 Oct 2026 11:00:00 GMT".into();
            if with_etag {
                o.etag = Some("\"v2\"".into());
            }
        }
        tm.resume(&id).expect("resume");
        let t = finished(&tm, &id).await;
        assert_eq!(t.status, TransferStatus::Failed, "etag {with_etag}");
        let error = t.error.unwrap_or_default();
        if with_etag {
            assert!(error.contains("PreconditionFailed"), "{error}");
        } else {
            assert_eq!(error, "The object changed during the download; try again");
        }
        assert_eq!(dir.files(), vec!["obj.bin".to_string()], "temp file removed");
        assert_eq!(std::fs::read(&dest).expect("file"), b"previous version", "the existing file is untouched");
        assert!(tm.start_download(s3.client(), "b", "k", dir.0.join("obj.bin")).is_ok(), "destination released");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_or_exiting_with_a_paused_download_removes_its_temp_file() {
    for exit in [false, true] {
        let dir = ScratchDir::new("pause-dl-cancel");
        let object = Arc::new(Mutex::new(Object { size: 8 * MIB, etag: Some("\"v1\"".into()), last_modified: "Mon, 05 Oct 2026 10:00:00 GMT".into(), hold_from: 2 * MIB }));
        let s3 = object_server(object).await;
        let tm = manager(ranged_settings(2), Arc::new(NoopSink));
        let id = download_held_after_two_parts(&tm, &s3, dir.0.join("obj.bin")).await;
        tm.pause(&id).expect("pause");
        status_is(&tm, &id, TransferStatus::Paused).await;
        if exit {
            assert_eq!(tm.cancel_active_and_wait(LIMIT).await, 0);
        } else {
            tm.cancel(&id).expect("cancel");
        }
        assert_eq!(finished(&tm, &id).await.status, TransferStatus::Cancelled);
        assert!(dir.files().is_empty(), "{:?}", dir.files());
        assert!(!tm.has_active());
    }
}

/// Multipart upload server: parts numbered `hold_from` and up are held open while `hold` is set.
struct UploadServer {
    hold: bool,
    hold_from: u32,
}

async fn upload_server(state: Arc<Mutex<UploadServer>>) -> FakeS3 {
    FakeS3::start(move |r: &Req| {
        let part = r.query.split('&').find_map(|p| p.strip_prefix("partNumber=")).and_then(|n| n.parse::<u32>().ok());
        match (r.method.as_str(), part) {
            ("POST", _) if r.has_query("uploads") => Reply::xml(
                200,
                "<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>U1</UploadId></InitiateMultipartUploadResult>",
            ),
            ("PUT", Some(n)) => {
                let s = state.lock().unwrap();
                if s.hold && n >= s.hold_from {
                    Reply::Hang
                } else {
                    Reply::with_headers(200, vec![h("ETag", &format!("\"p{n}\""))])
                }
            }
            ("PUT", None) => {
                if state.lock().unwrap().hold {
                    Reply::Hang
                } else {
                    Reply::with_headers(200, vec![h("ETag", "\"whole\"")])
                }
            }
            ("POST", _) if r.has_query("uploadId") => Reply::xml(
                200,
                "<CompleteMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><ETag>\"done\"</ETag></CompleteMultipartUploadResult>",
            ),
            ("DELETE", _) if r.has_query("uploadId") => Reply::status(204),
            _ => Reply::status(500),
        }
    })
    .await
}

fn part_puts(s3: &FakeS3, n: u32) -> usize {
    s3.count(|r| r.method == "PUT" && r.query.split('&').any(|p| p == format!("partNumber={n}")))
}

fn aborts(s3: &FakeS3) -> usize {
    s3.count(|r| r.method == "DELETE" && r.query.contains("uploadId=U1"))
}

/// A 12 MiB file in 5 MiB parts, one at a time; part 1 goes up, part 2 is held.
async fn upload_held_after_one_part(dir: &ScratchDir) -> (Arc<TransferManager>, FakeS3, Arc<Mutex<UploadServer>>, PathBuf, String) {
    let src = dir.0.join("up.bin");
    std::fs::write(&src, expected(12 * MIB)).expect("write");
    let state = Arc::new(Mutex::new(UploadServer { hold: true, hold_from: 2 }));
    let s3 = upload_server(state.clone()).await;
    let settings = TransferSettings { part_size_mib: Some(5), max_concurrent_parts: 1, ..TransferSettings::default() };
    let tm = manager(settings, Arc::new(NoopSink));
    let id = tm.start_upload(s3.client(), "b", "k", src.clone());
    until("part 1 sent and part 2 held", || part_puts(&s3, 2) == 1 && tm.get(&id).is_some_and(|t| t.parts_done == 1)).await;
    (tm, s3, state, src, id)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_upload_resumes_the_same_multipart_upload() {
    let dir = ScratchDir::new("pause-up");
    let (tm, s3, state, _src, id) = upload_held_after_one_part(&dir).await;
    tm.pause(&id).expect("pause");
    status_is(&tm, &id, TransferStatus::Paused).await;
    let t = tm.get(&id).expect("known");
    assert_eq!((t.transferred_bytes, t.parts_done), (5 * MIB, 1));
    assert_eq!(tm.running_count(), 0);
    assert_eq!(aborts(&s3), 0, "a pause keeps the multipart upload");
    state.lock().unwrap().hold = false;
    tm.resume(&id).expect("resume");
    let t = finished(&tm, &id).await;
    assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
    assert_eq!(s3.count(|r| r.method == "POST" && r.has_query("uploads")), 1, "one multipart upload");
    assert_eq!((part_puts(&s3, 1), part_puts(&s3, 2), part_puts(&s3, 3)), (1, 2, 1), "part 1 is not sent again");
    let complete = s3.requests().into_iter().find(|r| r.method == "POST" && r.has_query("uploadId")).expect("completed");
    let body = String::from_utf8_lossy(&complete.body).to_string();
    for n in 1..=3 {
        assert!(body.contains(&format!("<PartNumber>{n}</PartNumber>")) && body.contains(&format!("p{n}")), "{body}");
    }
    assert_eq!(aborts(&s3), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn pausing_then_cancelling_or_exiting_or_changing_the_file_aborts_the_multipart_upload() {
    for how in ["cancel", "exit", "changed"] {
        let dir = ScratchDir::new("pause-up-abort");
        let (tm, s3, state, src, id) = upload_held_after_one_part(&dir).await;
        tm.pause(&id).expect("pause");
        status_is(&tm, &id, TransferStatus::Paused).await;
        let t = match how {
            "cancel" => {
                tm.cancel(&id).expect("cancel");
                finished(&tm, &id).await
            }
            "exit" => {
                assert_eq!(tm.cancel_active_and_wait(LIMIT).await, 0);
                finished(&tm, &id).await
            }
            _ => {
                // Same size, new content and modified time.
                std::thread::sleep(Duration::from_millis(20));
                std::fs::write(&src, vec![0u8; 12 * MIB as usize]).expect("rewrite");
                state.lock().unwrap().hold = false;
                tm.resume(&id).expect("resume");
                finished(&tm, &id).await
            }
        };
        if how == "changed" {
            assert_eq!(t.status, TransferStatus::Failed);
            assert!(t.error.as_deref().unwrap_or_default().contains("changed while the upload was paused"), "{:?}", t.error);
            assert_eq!(part_puts(&s3, 3), 0, "nothing more was sent");
        } else {
            assert_eq!(t.status, TransferStatus::Cancelled, "{how}");
        }
        assert_eq!(aborts(&s3), 1, "{how}: the multipart upload is aborted");
        assert_eq!(s3.count(|r| r.method == "POST" && r.has_query("uploadId")), 0, "{how}: never completed");
        assert!(!tm.has_active());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_small_upload_paused_mid_request_is_sent_again_on_resume() {
    let dir = ScratchDir::new("pause-put");
    let src = dir.0.join("small.bin");
    std::fs::write(&src, b"hello").expect("write");
    let state = Arc::new(Mutex::new(UploadServer { hold: true, hold_from: 1 }));
    let s3 = upload_server(state.clone()).await;
    let tm = manager(TransferSettings::default(), Arc::new(NoopSink));
    let id = tm.start_upload(s3.client(), "b", "k", src);
    until("put in flight", || s3.count(|r| r.method == "PUT") == 1).await;
    tm.pause(&id).expect("pause");
    status_is(&tm, &id, TransferStatus::Paused).await;
    assert_eq!(tm.get(&id).expect("known").transferred_bytes, 0);
    state.lock().unwrap().hold = false;
    tm.resume(&id).expect("resume");
    let t = finished(&tm, &id).await;
    assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
    let puts: Vec<Vec<u8>> = s3.requests().into_iter().filter(|r| r.method == "PUT").map(|r| r.body).collect();
    assert_eq!(puts, vec![b"hello".to_vec(), b"hello".to_vec()]);
}

/// Records the order in which transfers start running.
fn running_order() -> (Arc<Mutex<Vec<String>>>, Arc<dyn ProgressSink>) {
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let o = order.clone();
    let last = Mutex::new(std::collections::HashMap::<String, TransferStatus>::new());
    let sink: Arc<dyn ProgressSink> = Arc::new(move |t: &Transfer| {
        let mut last = last.lock().unwrap();
        if t.status == TransferStatus::Running && last.get(&t.id) != Some(&TransferStatus::Running) {
            o.lock().unwrap().push(t.key.clone());
        }
        last.insert(t.id.clone(), t.status);
    });
    (order, sink)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_transfer_frees_its_slot_and_keeps_its_place() {
    let dir = ScratchDir::new("pause-slot");
    // Keys in `held` never get an answer.
    let held: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(["/b/a".to_string(), "/b/b".to_string()].into()));
    let h2 = held.clone();
    let s3 = FakeS3::start(move |r: &Req| {
        let etag = h("ETag", "\"e\"");
        match r.method.as_str() {
            "HEAD" => Reply::with_headers(200, vec![h("Content-Length", "3"), etag]),
            "GET" if h2.lock().unwrap().contains(&r.path) => Reply::Hang,
            "GET" => Reply::Full { status: 200, headers: vec![etag], body: b"abc".to_vec() },
            _ => Reply::status(500),
        }
    })
    .await;
    let (order, sink) = running_order();
    let tm = manager(TransferSettings { max_concurrent_transfers: 1, ..TransferSettings::default() }, sink);
    let a = tm.start_download(s3.client(), "b", "a", dir.0.join("a")).expect("a");
    status_is(&tm, &a, TransferStatus::Running).await;
    let b = tm.start_download(s3.client(), "b", "b", dir.0.join("b")).expect("b");
    let c = tm.start_download(s3.client(), "b", "c", dir.0.join("c")).expect("c");
    until("a's GET in flight", || s3.count(|r| r.method == "GET") == 1).await;

    // Pausing the running one lets the next in line run, within the limit of 1.
    tm.pause(&a).expect("pause a");
    status_is(&tm, &a, TransferStatus::Paused).await;
    status_is(&tm, &b, TransferStatus::Running).await;
    assert_eq!(tm.running_count(), 1);
    assert_eq!(tm.get(&c).expect("c").status, TransferStatus::Queued);
    // A queued transfer pauses too, and comes back at its old place.
    tm.pause(&c).expect("pause c");
    status_is(&tm, &c, TransferStatus::Paused).await;
    tm.resume(&c).expect("resume c");
    status_is(&tm, &c, TransferStatus::Queued).await;
    // a resumes behind c, which was queued before a was paused.
    held.lock().unwrap().remove("/b/a");
    tm.resume(&a).expect("resume a");
    status_is(&tm, &a, TransferStatus::Queued).await;
    assert_eq!(tm.running_count(), 1);
    tm.cancel(&b).expect("cancel b");
    for id in [&b, &c, &a] {
        finished(&tm, id).await;
    }
    assert_eq!(tm.get(&c).expect("c").status, TransferStatus::Completed);
    assert_eq!(tm.get(&a).expect("a").status, TransferStatus::Completed);
    assert_eq!(*order.lock().unwrap(), ["a", "b", "c", "a"]);
    assert_eq!(std::fs::read(dir.0.join("a")).expect("a"), b"abc");
    assert!(tm.resume(&a).is_ok(), "resuming a finished transfer is a no-op");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_folder_upload_pauses_its_files_and_resumes_them() {
    let dir = ScratchDir::new("pause-batch");
    let root = dir.0.join("photos");
    std::fs::create_dir_all(&root).expect("root");
    for n in ["a.txt", "b.txt", "c.txt"] {
        std::fs::write(root.join(n), n.as_bytes()).expect("write");
    }
    let state = Arc::new(Mutex::new(UploadServer { hold: true, hold_from: 1 }));
    let s3 = upload_server(state.clone()).await;
    let tm = manager(TransferSettings { max_concurrent_transfers: 1, ..TransferSettings::default() }, Arc::new(NoopSink));
    let bm = BatchManager::new(tm.clone(), Arc::new(NoopBatchSink));
    let req = BatchPlanRequest {
        kind: BatchKind::Upload,
        bucket: "b".into(),
        prefix: "p/".into(),
        local_path: root.display().to_string(),
        on_conflict: ConflictPolicy::Overwrite,
    };
    let id = bm.start(req, s3.client()).expect("start");
    until("first file in flight", || s3.count(|r| r.method == "PUT") == 1).await;
    bm.pause(&id).await.expect("pause");
    assert_eq!(bm.get(&id).expect("batch").status, BatchStatus::Paused);
    let files = bm.transfer_ids(&id);
    assert_eq!(files.len(), 3);
    for f in &files {
        status_is(&tm, f, TransferStatus::Paused).await;
    }
    assert_eq!(tm.running_count(), 0);
    assert!(bm.remove(&id).is_err(), "a paused batch cannot be removed");
    state.lock().unwrap().hold = false;
    bm.resume(&id).await.expect("resume");
    let b = tokio::time::timeout(LIMIT, bm.wait(&id)).await.expect("in time").expect("known");
    assert_eq!(b.status, BatchStatus::Completed, "{b:?}");
    assert_eq!(b.done_files, 3);
    let mut bodies: Vec<String> =
        s3.requests().into_iter().filter(|r| r.method == "PUT").map(|r| String::from_utf8_lossy(&r.body).into_owned()).collect();
    bodies.sort();
    assert_eq!(bodies, ["a.txt", "a.txt", "b.txt", "c.txt"], "the interrupted file is sent again, the others once");
    assert!(bm.pause(&id).await.is_err(), "a finished batch cannot be paused");
}

/// Pause all racing Resume all on the same folder transfer: whichever lands last wins, but the
/// batch and its files always agree (never `queued` with every file paused, or the reverse).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_pause_and_resume_of_a_batch_never_strand_it() {
    let dir = ScratchDir::new("pause-race");
    let root = dir.0.join("many");
    std::fs::create_dir_all(&root).expect("root");
    const FILES: usize = 300;
    for i in 0..FILES {
        std::fs::write(root.join(format!("f{i:04}.txt")), b"x").expect("write");
    }
    // Every PUT hangs: one file holds the only run slot, the rest stay queued.
    let state = Arc::new(Mutex::new(UploadServer { hold: true, hold_from: 1 }));
    let s3 = upload_server(state.clone()).await;
    let tm = manager(TransferSettings { max_concurrent_transfers: 1, ..TransferSettings::default() }, Arc::new(NoopSink));
    let bm = BatchManager::new(tm.clone(), Arc::new(NoopBatchSink));
    let req = BatchPlanRequest {
        kind: BatchKind::Upload,
        bucket: "b".into(),
        prefix: "p/".into(),
        local_path: root.display().to_string(),
        on_conflict: ConflictPolicy::Overwrite,
    };
    let id = bm.start(req, s3.client()).expect("start");
    until("every file started", || bm.transfer_ids(&id).len() == FILES).await;
    let files = bm.transfer_ids(&id);

    for round in 0..40 {
        let (p, r) = (bm.clone(), bm.clone());
        let (pid, rid) = (id.clone(), id.clone());
        // Alternate which call is spawned first so both orders race.
        let (a, b) = if round % 2 == 0 {
            (tokio::spawn(async move { p.pause(&pid).await }), tokio::spawn(async move { r.resume(&rid).await }))
        } else {
            let b = tokio::spawn(async move { r.resume(&rid).await });
            (tokio::spawn(async move { p.pause(&pid).await }), b)
        };
        a.await.expect("join").expect("pause");
        b.await.expect("join").expect("resume");
        let paused = bm.get(&id).expect("batch").status == BatchStatus::Paused;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let files_paused = files.iter().filter(|f| tm.get(f).is_some_and(|t| t.status == TransferStatus::Paused)).count();
            let want = if paused { FILES } else { 0 };
            if files_paused == want {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "round {round}: batch paused = {paused} but {files_paused} of {FILES} files are paused"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    bm.cancel(&id).expect("cancel");
    let b = tokio::time::timeout(LIMIT, bm.wait(&id)).await.expect("in time").expect("known");
    assert_eq!(b.status, BatchStatus::Cancelled);
}

/// App exit cancels running transfers too, not only paused ones: a multipart upload in flight is
/// aborted rather than left behind, and a running download's temp file is removed.
#[tokio::test(flavor = "multi_thread")]
async fn exiting_with_a_running_transfer_aborts_and_cleans_up() {
    let dir = ScratchDir::new("exit-running-up");
    let (tm, s3, _state, _src, id) = upload_held_after_one_part(&dir).await;
    assert_eq!(tm.get(&id).expect("known").status, TransferStatus::Running);
    assert_eq!(tm.cancel_active_and_wait(LIMIT).await, 0);
    assert_eq!(finished(&tm, &id).await.status, TransferStatus::Cancelled);
    assert_eq!(aborts(&s3), 1, "the running multipart upload is aborted");
    assert!(!tm.has_active());

    let dir = ScratchDir::new("exit-running-dl");
    let object = Arc::new(Mutex::new(Object { size: 8 * MIB, etag: Some("\"v1\"".into()), last_modified: "Mon, 05 Oct 2026 10:00:00 GMT".into(), hold_from: 2 * MIB }));
    let s3 = object_server(object).await;
    let tm = manager(ranged_settings(2), Arc::new(NoopSink));
    let id = download_held_after_two_parts(&tm, &s3, dir.0.join("obj.bin")).await;
    assert_eq!(tm.cancel_active_and_wait(LIMIT).await, 0);
    assert_eq!(finished(&tm, &id).await.status, TransferStatus::Cancelled);
    assert!(dir.files().is_empty(), "{:?}", dir.files());
}
