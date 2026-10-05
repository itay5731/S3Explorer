//! Transfer benchmark against an S3-compatible endpoint, driving the real `TransferManager`
//! (no Tauri). Local SeaweedFS only: credentials come from the command line, never from `~/.aws`.
//!
//! ```text
//! cargo run --release --example bench -- gen  --out D:\x\big.bin --mib 9728
//! cargo run --release --example bench -- put  --file D:\x\big.bin --key big.bin
//! cargo run --release --example bench -- get  --key big.bin --out D:\x\dl.bin --part-mib 100 --parts 32 --verify
//! ```
//! Common options: `--endpoint` (default http://127.0.0.1:8333), `--bucket` (default `bench`),
//! `--ak`/`--sk` (default minioadmin). `get`: `--part-mib N|auto` (default auto), `--parts N`
//! (default 8), `--sha HEX` (compare) or `--verify` (just print), `--keep` (keep the file),
//! `--timeline` (MiB/s per second).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use s3explorer_lib::models::{ConnectionConfig, Transfer, TransferSettings, TransferStatus};
use s3explorer_lib::state::Connection;
use s3explorer_lib::transfers::{ProgressSink, TransferManager};
use sha2::{Digest, Sha256};

type Res<T> = Result<T, Box<dyn std::error::Error>>;
const MIB: f64 = 1024.0 * 1024.0;

#[derive(Default)]
struct Probe {
    events: AtomicUsize,
    peak_bps: AtomicU64,
    last_bytes: AtomicU64,
    /// Events whose transferredBytes went backwards.
    regressions: AtomicUsize,
    /// (seconds since start, transferredBytes) samples for the timeline.
    samples: Mutex<Vec<(f64, u64)>>,
    t0: Mutex<Option<Instant>>,
}

impl ProgressSink for Probe {
    fn emit(&self, t: &Transfer) {
        self.events.fetch_add(1, Ordering::Relaxed);
        if t.status == TransferStatus::Running {
            self.peak_bps.fetch_max(t.bytes_per_sec, Ordering::Relaxed);
        }
        let prev = self.last_bytes.swap(t.transferred_bytes, Ordering::Relaxed);
        if t.transferred_bytes < prev {
            self.regressions.fetch_add(1, Ordering::Relaxed);
        }
        if let (Ok(t0), Ok(mut s)) = (self.t0.lock(), self.samples.lock()) {
            if let Some(t0) = *t0 {
                s.push((t0.elapsed().as_secs_f64(), t.transferred_bytes));
            }
        }
    }
}

/// (peak working set, peak private bytes) of this process, in bytes.
#[cfg(windows)]
fn peak_memory() -> Option<(u64, u64)> {
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_nonpaged: usize,
        quota_nonpaged: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
    }
    let mut c = Counters { cb: std::mem::size_of::<Counters>() as u32, ..Default::default() };
    // SAFETY: plain Win32 call with a correctly sized, writable struct.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (ok != 0).then_some((c.peak_working_set as u64, c.peak_pagefile_usage as u64))
}

#[cfg(not(windows))]
fn peak_memory() -> Option<(u64, u64)> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    let kb = |name: &str| -> Option<u64> {
        let line = s.lines().find(|l| l.starts_with(name))?;
        line.split_whitespace().nth(1)?.parse::<u64>().ok().map(|v| v * 1024)
    };
    Some((kb("VmHWM:")?, kb("VmPeak:")?))
}

fn sha_file(path: &std::path::Path) -> Res<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Writes `mib` MiB of xorshift data (incompressible) and prints its SHA-256.
fn gen(out: &str, mib: u64, mut seed: u64) -> Res<()> {
    let t0 = Instant::now();
    let mut f = std::io::BufWriter::with_capacity(8 << 20, std::fs::File::create(out)?);
    let mut h = Sha256::new();
    let mut block = vec![0u8; 1 << 20];
    for _ in 0..mib {
        for c in block.chunks_exact_mut(8) {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            c.copy_from_slice(&seed.to_le_bytes());
        }
        h.update(&block);
        f.write_all(&block)?;
    }
    f.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    let secs = t0.elapsed().as_secs_f64();
    let sha: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    println!("gen {out}: {mib} MiB in {secs:.1}s ({:.0} MiB/s), sha256 {sha}", mib as f64 / secs);
    Ok(())
}

#[tokio::main]
async fn main() -> Res<()> {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().ok_or("usage: bench gen|put|get [options]")?;
    let mut opt: HashMap<String, String> = HashMap::new();
    while let Some(a) = args.next() {
        let name = a.strip_prefix("--").ok_or_else(|| format!("unexpected argument {a}"))?.to_string();
        let flag = matches!(name.as_str(), "verify" | "keep" | "timeline");
        let value = if flag { String::new() } else { args.next().ok_or_else(|| format!("--{name} needs a value"))? };
        opt.insert(name, value);
    }
    let get = |k: &str, d: &str| opt.get(k).cloned().unwrap_or_else(|| d.to_string());

    if cmd == "gen" {
        return gen(&get("out", ""), get("mib", "1024").parse()?, get("seed", "40503").parse()?);
    }

    let part_size_mib = match get("part-mib", "auto").as_str() {
        "auto" => None,
        n => Some(n.parse()?),
    };
    let parts: u32 = get("parts", "8").parse()?;
    let settings = TransferSettings { part_size_mib, max_concurrent_parts: parts, max_concurrent_transfers: 1 };
    settings.validate().map_err(|e| e.message)?;
    let conn = Connection::open(ConnectionConfig::Static {
        access_key_id: get("ak", "minioadmin"),
        secret_access_key: get("sk", "minioadmin"),
        session_token: None,
        region: "us-east-1".into(),
        endpoint: Some(get("endpoint", "http://127.0.0.1:8333")),
        force_path_style: None,
    })
    .await?;
    let bucket = get("bucket", "bench");
    let key = get("key", "big.bin");
    let client = conn.client_for_bucket(&bucket).await;
    let probe = Arc::new(Probe::default());
    let tm = TransferManager::with_settings(probe.clone(), settings);

    *probe.t0.lock().map_err(|_| "poisoned")? = Some(Instant::now());
    let t0 = Instant::now();
    let (id, out) = match cmd.as_str() {
        "put" => {
            let _ = client.create_bucket().bucket(&bucket).send().await;
            (tm.start_upload(client.clone(), &bucket, &key, PathBuf::from(get("file", ""))), None)
        }
        "get" => {
            let out = PathBuf::from(get("out", ""));
            let _ = std::fs::remove_file(&out);
            (tm.start_download(client.clone(), &bucket, &key, out.clone())?, Some(out))
        }
        other => return Err(format!("unknown command {other}").into()),
    };
    let t = tm.wait(&id).await.ok_or("transfer vanished")?;
    let secs = t0.elapsed().as_secs_f64();
    let st = tm.stats(&id).unwrap_or_default();
    let (ws, private) = peak_memory().unwrap_or((0, 0));
    let mib = t.total_bytes as f64 / MIB;
    println!(
        "{cmd} {key} part={} parts={parts}: {:?}{} | {mib:.0} MiB in {secs:.2}s = {:.1} MiB/s avg, peak {:.1} MiB/s | partsTotal {} | peak in flight {} | retries {} | discarded {:.1} MiB | peak WS {:.0} MiB, peak private {:.0} MiB | events {} (backwards {})",
        part_size_mib.map_or("auto".to_string(), |m| format!("{m}MiB")),
        t.status,
        t.error.as_deref().map(|e| format!(" ({e})")).unwrap_or_default(),
        mib / secs,
        probe.peak_bps.load(Ordering::Relaxed) as f64 / MIB,
        t.parts_total,
        st.peak_parts_in_flight,
        st.part_retries,
        st.discarded_bytes as f64 / MIB,
        ws as f64 / MIB,
        private as f64 / MIB,
        probe.events.load(Ordering::Relaxed),
        probe.regressions.load(Ordering::Relaxed),
    );
    if opt.contains_key("timeline") {
        let s = probe.samples.lock().map_err(|_| "poisoned")?.clone();
        let mut line = String::from("timeline MiB/s per s:");
        let mut prev = (0.0f64, 0u64);
        for (ts, b) in s {
            if ts - prev.0 >= 1.0 {
                line.push_str(&format!(" {:.0}", b.saturating_sub(prev.1) as f64 / MIB / (ts - prev.0)));
                prev = (ts, b);
            }
        }
        println!("{line}");
    }
    if let Some(out) = out {
        if t.status == TransferStatus::Completed && (opt.contains_key("verify") || opt.contains_key("sha")) {
            let v0 = Instant::now();
            let sha = sha_file(&out)?;
            let verdict = match opt.get("sha") {
                Some(want) if want == &sha => " MATCH",
                Some(_) => " MISMATCH",
                None => "",
            };
            println!("sha256 {sha}{verdict} ({:.1}s)", v0.elapsed().as_secs_f64());
        }
        if !opt.contains_key("keep") {
            let _ = std::fs::remove_file(&out);
        }
    }
    if t.status != TransferStatus::Completed {
        std::process::exit(1);
    }
    Ok(())
}
