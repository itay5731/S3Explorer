//! End-to-end tests for v0.4.0's lifecycle configuration and bucket versioning against a local
//! S3-compatible server (SeaweedFS, see the smoke-test skill).
//!
//! Part 1 probes which lifecycle features the server accepts and stores faithfully (each through
//! `put_lifecycle`, which reads back and puts the previous configuration back when the server
//! drops something). Part 2 runs the scenarios, each asserting what is stored before and after.
//!
//! Only throwaway buckets named `lc-e2e-*` are used, seeded with a few small objects whose survival
//! is checked at the end. No rule expires anything sooner than 365 days.
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin).
//!
//! Run: `cargo run --example lifecycle`

use std::collections::BTreeMap;

use aws_sdk_s3::config::interceptors::FinalizerInterceptorContextMut;
use aws_sdk_s3::config::{ConfigBag, Intercept, RuntimeComponents};
use aws_sdk_s3::operation::get_bucket_lifecycle_configuration::GetBucketLifecycleConfigurationOutput;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types as s3;
use aws_sdk_s3::Client;
use s3explorer_lib::error::{AppError, ErrorCode};
use s3explorer_lib::lifecycle::{self, same_configuration};
use s3explorer_lib::models::{
    AbortIncompleteMultipartUpload, BucketVersioning, ConnectionConfig, LifecycleConfiguration, LifecycleExpiration,
    LifecycleFilter, LifecycleRule, LifecycleTransition, NoncurrentExpiration, NoncurrentTransition, RuleStatus,
    StorageClass as C, Tag,
};
use s3explorer_lib::state::Connection;
use s3explorer_lib::ops;
use serde_json::Number;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Debug)]
struct DropNoncurrentExpiration;

impl Intercept for DropNoncurrentExpiration {
    fn name(&self) -> &'static str {
        "DropNoncurrentExpiration"
    }
    fn modify_before_completion(
        &self,
        context: &mut FinalizerInterceptorContextMut<'_>,
        _rc: &RuntimeComponents,
        _cfg: &mut ConfigBag,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(Ok(out)) = context.output_or_error_mut() {
            if let Some(o) = out.downcast_mut::<GetBucketLifecycleConfigurationOutput>() {
                for r in o.rules.iter_mut().flatten() {
                    r.noncurrent_version_expiration = None;
                }
            }
        }
        Ok(())
    }
}

const MAIN: &str = "lc-e2e-main";
const PROBE: &str = "lc-e2e-probe";
const SEED: [&str; 4] = ["keep/a.txt", "logs/b.log", "data/raw/c.bin", "d.txt"];

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn check(cond: bool, what: &str) -> Res<()> {
    if cond {
        println!("  ok  {what}");
        Ok(())
    } else {
        Err(format!("FAILED: {what}").into())
    }
}

fn expect_err<T: std::fmt::Debug>(r: Result<T, AppError>, code: ErrorCode, what: &str) -> Res<AppError> {
    match r {
        Ok(v) => Err(format!("FAILED: {what}: expected {code:?}, got Ok({v:?})").into()),
        Err(e) if e.code == code => {
            println!("  ok  {what} -> {:?}: {}", e.code, e.message);
            Ok(e)
        }
        Err(e) => Err(format!("FAILED: {what}: expected {code:?}, got {:?}: {}", e.code, e.message).into()),
    }
}

// ---- rule builders -------------------------------------------------------------------------

fn n(i: i64) -> Option<Number> {
    Some(Number::from(i))
}
fn rule(id: &str) -> LifecycleRule {
    LifecycleRule {
        id: id.into(),
        status: RuleStatus::Enabled,
        filter: LifecycleFilter::default(),
        transitions: vec![],
        expiration: Some(LifecycleExpiration { days: n(365), date: None, expired_object_delete_marker: false }),
        noncurrent_version_transitions: vec![],
        noncurrent_version_expiration: None,
        abort_incomplete_multipart_upload: None,
    }
}
fn only(r: LifecycleRule) -> LifecycleRule {
    LifecycleRule { expiration: None, ..r }
}
fn prefix(p: &str) -> LifecycleFilter {
    LifecycleFilter { prefix: Some(p.into()), ..Default::default() }
}
fn tr(d: i64, c: C) -> LifecycleTransition {
    LifecycleTransition { days: n(d), date: None, storage_class: c }
}
fn cfg(rules: Vec<LifecycleRule>) -> LifecycleConfiguration {
    LifecycleConfiguration { rules }
}

/// One feature per probe: name and the single-rule configuration that exercises it.
fn probes() -> Vec<(&'static str, LifecycleConfiguration)> {
    let tagged = LifecycleFilter { tags: vec![Tag::new("env", "prod")], ..Default::default() };
    vec![
        ("expiration days, whole bucket (Filter {})", cfg(vec![rule("p-whole")])),
        ("filter: prefix", cfg(vec![LifecycleRule { filter: prefix("logs/"), ..rule("p-prefix") }])),
        ("filter: empty prefix (Filter{Prefix:\"\"})", cfg(vec![LifecycleRule { filter: prefix(""), ..rule("p-empty-prefix") }])),
        ("filter: one tag", cfg(vec![LifecycleRule { filter: tagged.clone(), ..rule("p-tag") }])),
        (
            "filter: And (prefix + 2 tags)",
            cfg(vec![LifecycleRule {
                filter: LifecycleFilter {
                    prefix: Some("data/".into()),
                    tags: vec![Tag::new("env", "prod"), Tag::new("team", "a")],
                    ..Default::default()
                },
                ..rule("p-and")
            }]),
        ),
        (
            "filter: objectSizeGreaterThan",
            cfg(vec![LifecycleRule {
                filter: LifecycleFilter { object_size_greater_than: n(1024), ..Default::default() },
                ..rule("p-gt")
            }]),
        ),
        (
            "filter: objectSizeLessThan",
            cfg(vec![LifecycleRule {
                filter: LifecycleFilter { object_size_less_than: n(1_048_576), ..Default::default() },
                ..rule("p-lt")
            }]),
        ),
        (
            "filter: And (size range)",
            cfg(vec![LifecycleRule {
                filter: LifecycleFilter { object_size_greater_than: n(10), object_size_less_than: n(1_048_576), ..Default::default() },
                ..rule("p-and-size")
            }]),
        ),
        (
            "expiration date",
            cfg(vec![LifecycleRule {
                expiration: Some(LifecycleExpiration { days: None, date: Some("2030-01-01T00:00:00Z".into()), expired_object_delete_marker: false }),
                ..rule("p-date")
            }]),
        ),
        (
            "expiration: expired object delete marker",
            cfg(vec![LifecycleRule {
                expiration: Some(LifecycleExpiration { days: None, date: None, expired_object_delete_marker: true }),
                ..rule("p-eodm")
            }]),
        ),
        ("status Disabled", cfg(vec![LifecycleRule { status: RuleStatus::Disabled, ..rule("p-disabled") }])),
        ("transition (days)", cfg(vec![only(LifecycleRule { transitions: vec![tr(30, C::StandardIa)], ..rule("p-tr") })])),
        (
            "transition (date)",
            cfg(vec![only(LifecycleRule {
                transitions: vec![LifecycleTransition { days: None, date: Some("2030-01-01T00:00:00Z".into()), storage_class: C::Glacier }],
                ..rule("p-tr-date")
            })]),
        ),
        (
            "transitions (3 tiers) + expiration",
            cfg(vec![LifecycleRule {
                transitions: vec![tr(30, C::StandardIa), tr(90, C::Glacier), tr(180, C::DeepArchive)],
                expiration: Some(LifecycleExpiration { days: n(400), date: None, expired_object_delete_marker: false }),
                ..rule("p-tiers")
            }]),
        ),
        (
            "noncurrent transition",
            cfg(vec![only(LifecycleRule {
                noncurrent_version_transitions: vec![NoncurrentTransition { noncurrent_days: n(30), newer_noncurrent_versions: None, storage_class: C::Glacier }],
                ..rule("p-nct")
            })]),
        ),
        (
            "noncurrent transition with newerNoncurrentVersions",
            cfg(vec![only(LifecycleRule {
                noncurrent_version_transitions: vec![NoncurrentTransition { noncurrent_days: n(30), newer_noncurrent_versions: n(2), storage_class: C::Glacier }],
                ..rule("p-nct-newer")
            })]),
        ),
        (
            "noncurrent expiration",
            cfg(vec![only(LifecycleRule {
                noncurrent_version_expiration: Some(NoncurrentExpiration { noncurrent_days: n(365), newer_noncurrent_versions: None }),
                ..rule("p-nce")
            })]),
        ),
        (
            "noncurrent expiration with newerNoncurrentVersions",
            cfg(vec![only(LifecycleRule {
                noncurrent_version_expiration: Some(NoncurrentExpiration { noncurrent_days: n(365), newer_noncurrent_versions: n(3) }),
                ..rule("p-nce-newer")
            })]),
        ),
        (
            "abort incomplete multipart upload",
            cfg(vec![only(LifecycleRule {
                abort_incomplete_multipart_upload: Some(AbortIncompleteMultipartUpload { days_after_initiation: n(7) }),
                ..rule("p-abort")
            })]),
        ),
        ("two rules", cfg(vec![LifecycleRule { filter: prefix("a/"), ..rule("p-two-1") }, LifecycleRule { filter: prefix("b/"), ..rule("p-two-2") }])),
    ]
}

#[derive(Debug, Clone, PartialEq)]
enum Probe {
    Stored,
    Dropped(String),
    Rejected(String),
}

async fn reset(c: &Client, bucket: &str) -> Res<()> {
    let cur = lifecycle::get_lifecycle(c, bucket).await?;
    lifecycle::put_lifecycle(c, bucket, &cfg(vec![]), cur.as_ref()).await?;
    check(lifecycle::get_lifecycle(c, bucket).await?.is_none(), &format!("{bucket}: lifecycle cleared"))?;
    Ok(())
}

async fn probe(c: &Client) -> Res<BTreeMap<&'static str, Probe>> {
    println!("== probe: lifecycle features on this server ({PROBE})");
    let mut out = BTreeMap::new();
    for (name, config) in probes() {
        let issues = lifecycle::validate_lifecycle(&config);
        if !issues.is_empty() {
            return Err(format!("probe config {name} is invalid: {issues:?}").into());
        }
        let before = lifecycle::get_lifecycle(c, PROBE).await?;
        let result = lifecycle::put_lifecycle(c, PROBE, &config, before.as_ref()).await;
        let p = match result {
            Ok(stored) => {
                if !same_configuration(stored.as_ref(), Some(&config)) {
                    return Err(format!("put_lifecycle returned Ok for {name} but the stored config differs").into());
                }
                Probe::Stored
            }
            Err(e) if e.message.contains("did not store all of it") => {
                // put_lifecycle put the previous configuration back: verify.
                let after = lifecycle::get_lifecycle(c, PROBE).await?;
                if !same_configuration(after.as_ref(), before.as_ref()) {
                    return Err(format!("{name}: previous configuration not restored").into());
                }
                Probe::Dropped(e.message)
            }
            Err(e) => {
                let after = lifecycle::get_lifecycle(c, PROBE).await?;
                if !same_configuration(after.as_ref(), before.as_ref()) {
                    return Err(format!("{name}: a rejected put changed the configuration").into());
                }
                Probe::Rejected(format!("{:?}: {}", e.code, e.message))
            }
        };
        match &p {
            Probe::Stored => println!("  STORED    {name}"),
            Probe::Dropped(m) => println!("  DROPPED   {name}\n            {m}"),
            Probe::Rejected(m) => println!("  REJECTED  {name}\n            {m}"),
        }
        out.insert(name, p);
        reset(c, PROBE).await.ok();
    }
    // Legacy top-level Prefix written raw: how does the server store and return it?
    #[allow(deprecated)]
    let legacy = s3::LifecycleRule::builder()
        .id("p-legacy")
        .prefix("old/")
        .status(s3::ExpirationStatus::Enabled)
        .expiration(s3::LifecycleExpiration::builder().days(365).build())
        .build()?;
    let raw = c
        .put_bucket_lifecycle_configuration()
        .bucket(PROBE)
        .lifecycle_configuration(s3::BucketLifecycleConfiguration::builder().rules(legacy).build()?)
        .send()
        .await;
    match raw {
        Ok(_) => {
            let got = lifecycle::get_lifecycle(c, PROBE).await?;
            let want = cfg(vec![LifecycleRule { filter: prefix("old/"), ..rule("p-legacy") }]);
            let ok = same_configuration(got.as_ref(), Some(&want));
            println!("  {}  legacy top-level Prefix (raw put) -> read as {:?}", if ok { "STORED  " } else { "DIFFERS " }, got.map(|g| g.rules[0].filter.clone()));
        }
        Err(e) => println!("  REJECTED  legacy top-level Prefix (raw put): {}", AppError::from(e).message),
    }
    reset(c, PROBE).await?;
    Ok(out)
}

/// Every key and its ETag.
async fn objects(c: &Client, bucket: &str) -> Res<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for k in ops::list_all_keys(c, bucket, "").await? {
        let h = c.head_object().bucket(bucket).key(&k).send().await?;
        out.insert(k, h.e_tag().unwrap_or_default().to_string());
    }
    Ok(out)
}

/// Field-by-field comparison of what was sent with what the server returned, printed.
fn field_by_field(sent: &LifecycleConfiguration, got: &LifecycleConfiguration) -> Res<()> {
    check(sent.rules.len() == got.rules.len(), &format!("{} rules stored", sent.rules.len()))?;
    for (a, b) in sent.rules.iter().zip(&got.rules) {
        let (a, b) = (lifecycle::canonical_rule(a), lifecycle::canonical_rule(b));
        let va = serde_json::to_value(&a)?;
        let vb = serde_json::to_value(&b)?;
        let (Some(ma), Some(mb)) = (va.as_object(), vb.as_object()) else { return Err("not objects".into()) };
        for (k, x) in ma {
            let y = mb.get(k);
            if Some(x) != y {
                return Err(format!("FAILED: rule {}: field {k}: sent {x} got {y:?}", a.id).into());
            }
        }
        println!("  ok  rule {}: every field equal ({} fields)", a.id, ma.len());
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let ak = env("SMOKE_ACCESS_KEY", "minioadmin");
    let sk = env("SMOKE_SECRET_KEY", "minioadmin");
    let conn = Connection::open(ConnectionConfig::Static {
        access_key_id: ak,
        secret_access_key: sk,
        session_token: None,
        region: "us-east-1".into(),
        endpoint: Some(endpoint.clone()),
        force_path_style: None,
    })
    .await?;
    let c = conn.client_for_bucket(MAIN).await;
    println!("connected to {endpoint}");
    // A new bucket each run: versioning can never be turned back off once enabled.
    let ver = format!("lc-e2e-ver-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let ver = ver.as_str();

    // Throwaway buckets only. Each must be new or hold nothing but our seed objects.
    for b in [MAIN, PROBE, ver] {
        let _ = c.create_bucket().bucket(b).send().await;
        let keys = ops::list_all_keys(&c, b, "").await?;
        if keys.iter().any(|k| !SEED.contains(&k.as_str())) {
            return Err(format!("{b} holds objects this test did not create; refusing to put lifecycle rules on it").into());
        }
    }
    for k in SEED {
        c.put_object().bucket(MAIN).key(k).body(ByteStream::from(format!("seed {k}").into_bytes())).send().await?;
    }
    reset(&c, MAIN).await?;
    reset(&c, PROBE).await?;
    let seeded = objects(&c, MAIN).await?;
    check(seeded.len() == SEED.len(), "seed objects in place")?;

    let probed = probe(&c).await?;
    let accepted: Vec<&str> = probed.iter().filter(|(_, p)| **p == Probe::Stored).map(|(k, _)| *k).collect();

    // ---- scenarios -------------------------------------------------------------------------
    println!("== get on a fresh bucket");
    check(lifecycle::get_lifecycle(&c, MAIN).await?.is_none(), "get_lifecycle -> null")?;
    expect_err(lifecycle::get_lifecycle(&c, "lc-e2e-does-not-exist").await, ErrorCode::NoSuchBucket, "get_lifecycle on a missing bucket")?;
    expect_err(
        lifecycle::put_lifecycle(&c, "lc-e2e-does-not-exist", &cfg(vec![rule("x")]), None).await,
        ErrorCode::NoSuchBucket,
        "put_lifecycle on a missing bucket",
    )?;

    println!("== put a configuration with every feature the server stores");
    let mut rules: Vec<LifecycleRule> = Vec::new();
    for (name, config) in probes() {
        if accepted.contains(&name) {
            for (i, mut r) in config.rules.into_iter().enumerate() {
                r.id = format!("{}-{i}", r.id.replacen("p-", "f-", 1));
                rules.push(r);
            }
        }
    }
    let full = cfg(rules);
    println!("  ({} rules from {} stored features)", full.rules.len(), accepted.len());
    let stored = lifecycle::put_lifecycle(&c, MAIN, &full, None).await?;
    check(same_configuration(stored.as_ref(), Some(&full)), "put_lifecycle returns what was sent (semantically)")?;
    let got = lifecycle::get_lifecycle(&c, MAIN).await?.ok_or("nothing stored")?;
    check(same_configuration(Some(&got), Some(&full)), "get_lifecycle returns the same configuration")?;
    field_by_field(&full, &got)?;

    println!("== put with a stale expected");
    let before = lifecycle::get_lifecycle(&c, MAIN).await?;
    let change = cfg(vec![rule("replacement")]);
    let e = expect_err(lifecycle::put_lifecycle(&c, MAIN, &change, None).await, ErrorCode::Conflict, "expected null while the bucket has a configuration")?;
    check(e.message == lifecycle::CONFLICT, "conflict message")?;
    let mut stale = full.clone();
    stale.rules[0].status = RuleStatus::Disabled;
    expect_err(lifecycle::put_lifecycle(&c, MAIN, &change, Some(&stale)).await, ErrorCode::Conflict, "expected differs in one rule's status")?;
    let mut reordered = full.clone();
    if reordered.rules.len() > 1 {
        reordered.rules.swap(0, 1);
        expect_err(lifecycle::put_lifecycle(&c, MAIN, &change, Some(&reordered)).await, ErrorCode::Conflict, "expected has the same rules in another order")?;
    }
    check(lifecycle::get_lifecycle(&c, MAIN).await? == before, "configuration unchanged after the conflicts")?;

    println!("== put an invalid configuration");
    let invalid = cfg(vec![LifecycleRule { transitions: vec![tr(10, C::StandardIa)], ..rule("too-soon") }, rule("too-soon")]);
    let e = expect_err(lifecycle::put_lifecycle(&c, MAIN, &invalid, before.as_ref()).await, ErrorCode::InvalidInput, "invalid configuration")?;
    check(e.message.contains("2 problems") && e.message.contains("at least 30 days"), "message lists the issues")?;
    check(lifecycle::get_lifecycle(&c, MAIN).await? == before, "configuration unchanged")?;

    println!("== saving what is already stored is a no-op");
    let again = lifecycle::put_lifecycle(&c, MAIN, &full, before.as_ref()).await?;
    check(again == before, "returns the stored configuration unchanged")?;

    println!("== replace with one rule");
    let one = cfg(vec![LifecycleRule { filter: prefix("logs/"), ..rule("only-logs") }]);
    let stored = lifecycle::put_lifecycle(&c, MAIN, &one, Some(&full)).await?;
    check(same_configuration(stored.as_ref(), Some(&one)), "stored the single rule")?;

    println!("== a legacy rule (top-level Prefix) on the server matches an expected written with a Filter");
    #[allow(deprecated)]
    let legacy = s3::LifecycleRule::builder()
        .id("only-logs")
        .prefix("logs/")
        .status(s3::ExpirationStatus::Enabled)
        .expiration(s3::LifecycleExpiration::builder().days(365).build())
        .build()?;
    let raw = c
        .put_bucket_lifecycle_configuration()
        .bucket(MAIN)
        .lifecycle_configuration(s3::BucketLifecycleConfiguration::builder().rules(legacy).build()?)
        .send()
        .await;
    match raw {
        Ok(_) => {
            let two = cfg(vec![one.rules[0].clone(), LifecycleRule { filter: prefix("tmp/"), ..rule("tmp") }]);
            let stored = lifecycle::put_lifecycle(&c, MAIN, &two, Some(&one)).await?;
            check(same_configuration(stored.as_ref(), Some(&two)), "no conflict; the legacy rule is now written as a Filter")?;
            let stored = lifecycle::put_lifecycle(&c, MAIN, &one, Some(&two)).await?;
            check(same_configuration(stored.as_ref(), Some(&one)), "back to one rule")?;
        }
        Err(e) => println!("  --  the server rejects a top-level Prefix: {}", AppError::from(e).message),
    }

    println!("== put empty rules deletes the configuration");
    let stored = lifecycle::put_lifecycle(&c, MAIN, &cfg(vec![]), Some(&one)).await?;
    check(stored.is_none(), "put_lifecycle([]) returns null")?;
    check(lifecycle::get_lifecycle(&c, MAIN).await?.is_none(), "get_lifecycle -> null after delete")?;

    println!("== expected non-null when the bucket has none");
    expect_err(lifecycle::put_lifecycle(&c, MAIN, &one, Some(&one)).await, ErrorCode::Conflict, "expected a configuration that is gone")?;
    check(lifecycle::get_lifecycle(&c, MAIN).await?.is_none(), "still none")?;

    println!("== a feature the server does not store");
    let dropped: Vec<&str> = probed.iter().filter(|(_, p)| matches!(p, Probe::Dropped(_))).map(|(k, _)| *k).collect();
    let rejected: Vec<&str> = probed.iter().filter(|(_, p)| matches!(p, Probe::Rejected(_))).map(|(k, _)| *k).collect();
    // Start from a known configuration so "nothing changed" means something.
    lifecycle::put_lifecycle(&c, MAIN, &one, None).await?;
    let base = lifecycle::get_lifecycle(&c, MAIN).await?;
    for name in dropped.iter().chain(&rejected) {
        let Some((_, mut config)) = probes().into_iter().find(|(n, _)| n == name) else { continue };
        config.rules.insert(0, LifecycleRule { filter: prefix("logs/"), ..rule("only-logs") });
        config.rules.iter_mut().skip(1).for_each(|r| r.id = format!("{}-x", r.id));
        match lifecycle::put_lifecycle(&c, MAIN, &config, base.as_ref()).await {
            Ok(_) => return Err(format!("FAILED: {name} was stored in the scenario but not in the probe").into()),
            Err(e) => println!("  ok  {name} -> {:?}: {}", e.code, e.message),
        }
        check(lifecycle::get_lifecycle(&c, MAIN).await? == base, &format!("{name}: configuration unchanged"))?;
    }
    if dropped.is_empty() && rejected.is_empty() {
        println!("  (the server stored every probed feature; nothing to check here)");
    }

    println!("== a server that accepts a configuration but silently drops part of it");
    // Simulated: an interceptor removes NoncurrentVersionExpiration from every
    // GetBucketLifecycleConfiguration response, as a server that ignores it would return.
    let dropping = Client::from_conf(c.config().to_builder().interceptor(DropNoncurrentExpiration).build());
    let with_nce = cfg(vec![
        one.rules[0].clone(),
        only(LifecycleRule {
            noncurrent_version_expiration: Some(NoncurrentExpiration { noncurrent_days: n(365), newer_noncurrent_versions: None }),
            ..rule("versions")
        }),
    ]);
    let e = expect_err(
        lifecycle::put_lifecycle(&dropping, MAIN, &with_nce, base.as_ref()).await,
        ErrorCode::NotSupported,
        "put through the dropping server",
    )?;
    check(
        e.message.contains("rule 2 (“versions”): noncurrent-version expiration")
            && e.message.contains("The previous configuration was put back, so nothing changed."),
        "the message names what was not kept and says it was rolled back",
    )?;
    check(lifecycle::get_lifecycle(&c, MAIN).await? == base, "the real server holds the previous configuration again")?;
    reset(&c, MAIN).await?;

    println!("== bucket versioning");
    let v = lifecycle::get_bucket_versioning(&c, ver).await;
    match v {
        Ok(v) => {
            check(v == BucketVersioning::Off, &format!("fresh bucket -> {v:?}"))?;
            for (status, want) in [
                (s3::BucketVersioningStatus::Enabled, BucketVersioning::Enabled),
                (s3::BucketVersioningStatus::Suspended, BucketVersioning::Suspended),
            ] {
                let put = c
                    .put_bucket_versioning()
                    .bucket(ver)
                    .versioning_configuration(s3::VersioningConfiguration::builder().status(status.clone()).build())
                    .send()
                    .await;
                match put {
                    Ok(_) => {
                        let got = lifecycle::get_bucket_versioning(&c, ver).await?;
                        check(got == want, &format!("PutBucketVersioning {} -> {got:?}", status.as_str()))?;
                    }
                    Err(e) => println!("  --  PutBucketVersioning {} not supported: {}", status.as_str(), AppError::from(e).message),
                }
            }
        }
        Err(e) => println!("  --  GetBucketVersioning failed: {:?}: {}", e.code, e.message),
    }

    println!("== objects survived");
    check(objects(&c, MAIN).await? == seeded, "every seed object is still there with the same ETag")?;

    // Clean up the buckets' contents and configurations (the data dir is deleted afterwards).
    for k in SEED {
        c.delete_object().bucket(MAIN).key(k).send().await?;
    }
    for b in [MAIN, PROBE, ver] {
        if let Err(e) = c.delete_bucket().bucket(b).send().await {
            println!("  (could not delete bucket {b}: {})", AppError::from(e).message);
        }
    }
    println!("\nPASS: lifecycle");
    Ok(())
}
