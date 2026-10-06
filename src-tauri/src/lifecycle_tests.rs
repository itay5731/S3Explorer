//! Unit tests for `lifecycle.rs`: mapping round trips, legacy fixtures, unknown values, every
//! validation rule (a passing and a failing case each), and the semantic comparison.
// The legacy fixtures build rules with the deprecated top-level `Prefix`, as old servers return them.
#![allow(deprecated)]

use super::*;
use crate::models::{
    AbortIncompleteMultipartUpload, LifecycleConfiguration, LifecycleExpiration, LifecycleFilter, LifecycleRule,
    LifecycleTransition, NoncurrentExpiration, NoncurrentTransition, RuleStatus, StorageClass as C, Tag,
};
use serde_json::json;

// ---- helpers -------------------------------------------------------------------------------

/// 2025-06-01T00:00:00Z: the fixtures' 2026/2027 dates are in the future as of this "now".
const NOW: i64 = 1_748_736_000;

/// Validation as of [`NOW`] (shadows the glob-imported clock-based one).
fn validate_lifecycle(c: &LifecycleConfiguration) -> Vec<LifecycleIssue> {
    validate_lifecycle_at(c, NOW)
}

fn n(i: i64) -> Option<Number> {
    Some(Number::from(i))
}
fn f(x: f64) -> Option<Number> {
    Number::from_f64(x)
}
fn t(k: &str, v: &str) -> Tag {
    Tag::new(k, v)
}
fn tr_days(d: i64, c: C) -> LifecycleTransition {
    LifecycleTransition { days: n(d), date: None, storage_class: c }
}
fn tr_date(s: &str, c: C) -> LifecycleTransition {
    LifecycleTransition { days: None, date: Some(s.into()), storage_class: c }
}
fn exp_days(d: i64) -> Option<LifecycleExpiration> {
    Some(LifecycleExpiration { days: n(d), date: None, expired_object_delete_marker: false })
}
fn exp_date(s: &str) -> Option<LifecycleExpiration> {
    Some(LifecycleExpiration { days: None, date: Some(s.into()), expired_object_delete_marker: false })
}
fn eodm() -> Option<LifecycleExpiration> {
    Some(LifecycleExpiration { days: None, date: None, expired_object_delete_marker: true })
}
fn nct(d: i64, newer: Option<i64>, c: C) -> NoncurrentTransition {
    NoncurrentTransition { noncurrent_days: n(d), newer_noncurrent_versions: newer.and_then(n), storage_class: c }
}
fn nce(d: i64, newer: Option<i64>) -> Option<NoncurrentExpiration> {
    Some(NoncurrentExpiration { noncurrent_days: n(d), newer_noncurrent_versions: newer.and_then(n) })
}
fn abort(d: i64) -> Option<AbortIncompleteMultipartUpload> {
    Some(AbortIncompleteMultipartUpload { days_after_initiation: n(d) })
}
fn prefix(p: &str) -> LifecycleFilter {
    LifecycleFilter { prefix: Some(p.into()), ..Default::default() }
}

/// A minimal valid rule: whole bucket, expire after 365 days.
fn rule(id: &str) -> LifecycleRule {
    LifecycleRule {
        id: id.into(),
        status: RuleStatus::Enabled,
        filter: LifecycleFilter::default(),
        transitions: vec![],
        expiration: exp_days(365),
        noncurrent_version_transitions: vec![],
        noncurrent_version_expiration: None,
        abort_incomplete_multipart_upload: None,
    }
}
fn cfg(rules: Vec<LifecycleRule>) -> LifecycleConfiguration {
    LifecycleConfiguration { rules }
}
fn issues_of(r: LifecycleRule) -> Vec<LifecycleIssue> {
    validate_lifecycle(&cfg(vec![r]))
}
fn ok(r: LifecycleRule) {
    let i = issues_of(r.clone());
    assert!(i.is_empty(), "expected valid, got {i:#?} for {r:#?}");
}
/// Exactly one issue for the rule, at `field`, whose message contains `text`. Returns the message.
fn bad(r: LifecycleRule, field: Option<&str>, text: &str) -> String {
    let i = issues_of(r.clone());
    assert_eq!(i.len(), 1, "expected one issue, got {i:#?} for {r:#?}");
    assert_eq!(i[0].rule_index, Some(0));
    assert_eq!(i[0].field.as_deref(), field, "{i:#?}");
    assert!(i[0].message.contains(text), "message {:?} lacks {text:?}", i[0].message);
    i[0].message.clone()
}

const JAN1: &str = "2026-01-01T00:00:00Z";

// ---- mapping -------------------------------------------------------------------------------

/// Hand-written rules in canonical form covering every field and filter shape.
fn mapping_cases() -> Vec<LifecycleRule> {
    // whole bucket, expiration days
    let mut v = vec![rule("whole")];
    // prefix only, transitions by days, expiration days
    v.push(LifecycleRule {
        filter: prefix("logs/"),
        transitions: vec![tr_days(30, C::StandardIa), tr_days(90, C::Glacier), tr_days(180, C::DeepArchive)],
        ..rule("prefix")
    });
    // one tag, expiration by date
    v.push(LifecycleRule {
        filter: LifecycleFilter { tags: vec![t("env", "prod")], ..Default::default() },
        expiration: exp_date(JAN1),
        ..rule("tag")
    });
    // size greater than only, noncurrent actions with and without newer versions
    v.push(LifecycleRule {
        filter: LifecycleFilter { object_size_greater_than: n(1024), ..Default::default() },
        expiration: None,
        noncurrent_version_transitions: vec![nct(30, Some(3), C::OnezoneIa), nct(60, None, C::GlacierIr)],
        noncurrent_version_expiration: nce(365, Some(5)),
        ..rule("gt")
    });
    // size less than only, status disabled, abort only
    v.push(LifecycleRule {
        status: RuleStatus::Disabled,
        filter: LifecycleFilter { object_size_less_than: n(1_000_000_000_000), ..Default::default() },
        expiration: None,
        abort_incomplete_multipart_upload: abort(7),
        ..rule("lt")
    });
    // And with everything, transitions by date, expiration by date
    v.push(LifecycleRule {
        filter: LifecycleFilter {
            prefix: Some("data/raw/".into()),
            tags: vec![t("team", "a b"), t("tier", "cold")],
            object_size_greater_than: n(0),
            object_size_less_than: n(5_000_000),
        },
        transitions: vec![tr_date("2026-02-01T00:00:00Z", C::IntelligentTiering), tr_date("2026-06-01T00:00:00Z", C::Glacier)],
        expiration: exp_date("2027-01-01T00:00:00Z"),
        ..rule("and-all")
    });
    // And: prefix + size
    v.push(LifecycleRule {
        filter: LifecycleFilter { prefix: Some("p/".into()), object_size_greater_than: n(10), ..Default::default() },
        ..rule("and-prefix-size")
    });
    // And: two tags only
    v.push(LifecycleRule {
        filter: LifecycleFilter { tags: vec![t("a", "1"), t("b", "")], ..Default::default() },
        ..rule("and-tags")
    });
    // expired object delete marker + noncurrent expiration + abort, everything at once
    v.push(LifecycleRule {
        expiration: eodm(),
        noncurrent_version_expiration: nce(30, None),
        abort_incomplete_multipart_upload: abort(1),
        ..rule("markers")
    });
    // every action in one rule
    v.push(LifecycleRule {
        filter: prefix("all/"),
        transitions: vec![tr_days(30, C::StandardIa), tr_days(60, C::GlacierIr)],
        expiration: exp_days(400),
        noncurrent_version_transitions: vec![nct(30, Some(1), C::StandardIa), nct(90, Some(100), C::DeepArchive)],
        noncurrent_version_expiration: nce(120, Some(2)),
        abort_incomplete_multipart_upload: abort(3),
        ..rule("everything")
    });
    // an explicit empty prefix (S3's Filter{Prefix:""})
    v.push(LifecycleRule { filter: prefix(""), ..rule("empty-prefix") });
    // no id (S3 then assigns one); invalid for saving but must map faithfully
    v.push(rule(""));
    v
}

#[test]
fn round_trip_model_sdk_model() {
    for r in mapping_cases() {
        let sdk = rule_to_sdk(&r).expect("to sdk");
        let back = rule_from_sdk(0, &sdk).expect("from sdk");
        assert_eq!(back, r, "model -> sdk -> model changed {}", r.id);
        // and the SDK side: to_sdk(from_sdk(x)) == x
        let again = rule_to_sdk(&back).expect("to sdk again");
        assert_eq!(again, sdk, "sdk -> model -> sdk changed {}", r.id);
        // never the deprecated top-level Prefix, always a Filter
        assert!(sdk.prefix.is_none() && sdk.filter.is_some(), "{}", r.id);
    }
}

#[test]
fn round_trip_whole_configuration_and_json() {
    let c = cfg(mapping_cases());
    let sdk = config_to_sdk(&c).expect("to sdk");
    assert_eq!(sdk.rules.len(), c.rules.len());
    assert_eq!(config_from_sdk(&sdk.rules).expect("from sdk"), Some(c.clone()));
    // JSON round trip (what crosses the bridge)
    let text = serde_json::to_string(&c).expect("json");
    let back: LifecycleConfiguration = serde_json::from_str(&text).expect("parse");
    assert_eq!(back, c);
}

#[test]
fn filter_serialization_shapes() {
    // none -> Filter {}
    let e = filter_to_sdk(&LifecycleFilter::default()).expect("f");
    assert_eq!(e, s3::LifecycleRuleFilter::builder().build());
    // one condition -> that condition directly
    let p = filter_to_sdk(&prefix("logs/")).expect("f");
    assert_eq!(p.prefix.as_deref(), Some("logs/"));
    assert!(p.and.is_none() && p.tag.is_none());
    let tg = filter_to_sdk(&LifecycleFilter { tags: vec![t("k", "v")], ..Default::default() }).expect("f");
    assert_eq!(tg.tag.as_ref().map(|t| (t.key(), t.value())), Some(("k", "v")));
    assert!(tg.and.is_none());
    let gt = filter_to_sdk(&LifecycleFilter { object_size_greater_than: n(5), ..Default::default() }).expect("f");
    assert_eq!((gt.object_size_greater_than, gt.and.is_none()), (Some(5), true));
    let lt = filter_to_sdk(&LifecycleFilter { object_size_less_than: n(9), ..Default::default() }).expect("f");
    assert_eq!((lt.object_size_less_than, lt.and.is_none()), (Some(9), true));
    // several -> And, and nothing else directly
    let a = filter_to_sdk(&LifecycleFilter { prefix: Some("x/".into()), tags: vec![t("k", "v")], ..Default::default() })
        .expect("f");
    assert!(a.prefix.is_none() && a.tag.is_none() && a.object_size_greater_than.is_none());
    let and = a.and.expect("and");
    assert_eq!(and.prefix.as_deref(), Some("x/"));
    assert_eq!(and.tags().len(), 1);
    // two tags alone are already "several"
    let two = filter_to_sdk(&LifecycleFilter { tags: vec![t("a", "1"), t("b", "2")], ..Default::default() }).expect("f");
    assert!(two.tag.is_none() && two.and.as_ref().map(|a| a.tags().len()) == Some(2));
}

#[test]
fn dates_both_ways() {
    let secs = 1_767_225_600; // 2026-01-01T00:00:00Z
    assert_eq!(format_secs(secs), JAN1);
    assert_eq!(parse_midnight(JAN1), Ok(secs));
    assert_eq!(parse_midnight("2026-01-01"), Ok(secs));
    assert_eq!(parse_midnight("2026-01-01T00:00:00.000Z"), Ok(secs));
    assert_eq!(parse_midnight("2026-01-01T01:00:00+01:00"), Ok(secs));
    assert!(parse_midnight("2026-01-01T00:00:01Z").unwrap_err().contains("not at midnight UTC"));
    assert!(parse_midnight("2026-01-01T00:00:00+01:00").unwrap_err().contains("not at midnight UTC"));
    assert!(parse_midnight("2026-01-01T00:00:00.5Z").unwrap_err().contains("not at midnight UTC"));
    assert!(parse_midnight("01/02/2026").unwrap_err().contains("is not a date"));
    assert!(parse_midnight("2026-02-30").unwrap_err().contains("is not a date"));
    assert!(parse_midnight("").is_err());
    // SDK -> model -> SDK
    let r = rule_from_sdk(
        0,
        &s3::LifecycleRule::builder()
            .status(s3::ExpirationStatus::Enabled)
            .filter(s3::LifecycleRuleFilter::builder().build())
            .expiration(s3::LifecycleExpiration::builder().date(SdkDateTime::from_secs(secs)).build())
            .build()
            .expect("rule"),
    )
    .expect("from");
    assert_eq!(r.expiration.as_ref().and_then(|e| e.date.as_deref()), Some(JAN1));
    // A bare date the UI might send is written as midnight UTC.
    let sdk = rule_to_sdk(&LifecycleRule { expiration: exp_date("2026-01-01"), ..rule("d") }).expect("to");
    assert_eq!(sdk.expiration.and_then(|e| e.date), Some(SdkDateTime::from_secs(secs)));
}

#[test]
fn numbers_whole_or_not() {
    assert_eq!(int_of(&Number::from(30)), Some(30));
    assert_eq!(int_of(&Number::from(-3)), Some(-3));
    assert_eq!(f(30.0).as_ref().and_then(int_of), Some(30));
    assert_eq!(f(1.5).as_ref().and_then(int_of), None);
    assert_eq!(int_of(&Number::from(u64::MAX)), None);
    assert_eq!(f(1e300).as_ref().and_then(int_of), None);
    // to_sdk refuses (never truncates) a number that isn't a whole i32
    assert!(rule_to_sdk(&LifecycleRule { expiration: Some(LifecycleExpiration { days: f(1.5), ..Default::default() }), ..rule("x") })
        .is_err());
    assert!(rule_to_sdk(&LifecycleRule { expiration: exp_days(i64::from(i32::MAX) + 1), ..rule("x") }).is_err());
}

fn sdk_rule() -> aws_sdk_s3::types::builders::LifecycleRuleBuilder {
    s3::LifecycleRule::builder()
        .id("legacy")
        .status(s3::ExpirationStatus::Enabled)
        .expiration(s3::LifecycleExpiration::builder().days(30).build())
}

#[test]
fn legacy_top_level_prefix() {
    let legacy = sdk_rule().prefix("logs/").build().expect("rule");
    let r = rule_from_sdk(0, &legacy).expect("from");
    assert_eq!(r.filter, prefix("logs/"));
    // written back as a Filter, never the deprecated top-level Prefix
    let out = rule_to_sdk(&r).expect("to");
    assert!(out.prefix.is_none());
    assert_eq!(out.filter.as_ref().and_then(|f| f.prefix.as_deref()), Some("logs/"));
    // the same rule written with a Filter is semantically equal
    let modern = sdk_rule().filter(s3::LifecycleRuleFilter::builder().prefix("logs/").build()).build().expect("rule");
    let a = config_from_sdk(&[legacy]).expect("a");
    let b = config_from_sdk(&[modern]).expect("b");
    assert_eq!(a, b);
    assert!(same_configuration(a.as_ref(), b.as_ref()));
    // legacy whole-bucket rule: top-level Prefix ""
    let empty = rule_from_sdk(0, &sdk_rule().prefix("").build().expect("rule")).expect("from");
    assert_eq!(empty.filter, prefix(""));
    assert!(same_configuration(Some(&cfg(vec![empty])), Some(&cfg(vec![LifecycleRule { expiration: exp_days(30), ..rule("legacy") }]))));
    // top-level Prefix plus an empty Filter: the prefix is kept
    let both = rule_from_sdk(0, &sdk_rule().prefix("a/").filter(s3::LifecycleRuleFilter::builder().build()).build().expect("r"))
        .expect("from");
    assert_eq!(both.filter, prefix("a/"));
    // top-level Prefix plus a non-empty Filter has no single meaning: refused
    let e = rule_from_sdk(
        0,
        &sdk_rule().prefix("a/").filter(s3::LifecycleRuleFilter::builder().prefix("b/").build()).build().expect("r"),
    )
    .expect_err("refused");
    assert!(e.message.contains("both a top-level Prefix and a Filter"), "{}", e.message);
}

#[test]
fn legacy_empty_filter_and_empty_prefix_filter() {
    let empty = rule_from_sdk(0, &sdk_rule().filter(s3::LifecycleRuleFilter::builder().build()).build().expect("r")).expect("f");
    assert_eq!(empty.filter, LifecycleFilter::default());
    let empty_prefix =
        rule_from_sdk(0, &sdk_rule().filter(s3::LifecycleRuleFilter::builder().prefix("").build()).build().expect("r"))
            .expect("f");
    // kept faithfully (written back as Filter{Prefix:""}) ...
    assert_eq!(empty_prefix.filter, prefix(""));
    assert_eq!(rule_to_sdk(&empty_prefix).expect("to").filter.and_then(|f| f.prefix), Some(String::new()));
    // ... and semantically the same as Filter{}
    assert!(same_configuration(Some(&cfg(vec![empty])), Some(&cfg(vec![empty_prefix]))));
    // no Filter and no Prefix at all: whole bucket
    let none = rule_from_sdk(0, &sdk_rule().build().expect("r")).expect("f");
    assert_eq!(none.filter, LifecycleFilter::default());
}

#[test]
fn other_server_shapes() {
    // And with a single condition reads as that condition and is written directly.
    let and1 = sdk_rule()
        .filter(s3::LifecycleRuleFilter::builder().and(s3::LifecycleRuleAndOperator::builder().prefix("x/").build()).build())
        .build()
        .expect("r");
    let r = rule_from_sdk(0, &and1).expect("f");
    assert_eq!(r.filter, prefix("x/"));
    // Several direct conditions (invalid in S3, but one meaning): all kept.
    let tag = s3::Tag::builder().key("k").value("v").build().expect("tag");
    let direct = sdk_rule()
        .filter(s3::LifecycleRuleFilter::builder().prefix("x/").tag(tag.clone()).build())
        .build()
        .expect("r");
    let r = rule_from_sdk(0, &direct).expect("f");
    assert_eq!(r.filter, LifecycleFilter { prefix: Some("x/".into()), tags: vec![t("k", "v")], ..Default::default() });
    // And plus a direct condition: refused, never merged or dropped.
    let mixed = sdk_rule()
        .filter(
            s3::LifecycleRuleFilter::builder()
                .prefix("x/")
                .and(s3::LifecycleRuleAndOperator::builder().tags(tag).build())
                .build(),
        )
        .build()
        .expect("r");
    assert!(rule_from_sdk(0, &mixed).expect_err("refused").message.contains("both And and other conditions"));
    // ExpiredObjectDeleteMarker=false reads as false.
    let r = rule_from_sdk(
        0,
        &sdk_rule().expiration(s3::LifecycleExpiration::builder().days(5).expired_object_delete_marker(false).build()).build().expect("r"),
    )
    .expect("f");
    assert_eq!(r.expiration, exp_days(5));
    // Missing numbers are carried as null (and flagged by validation), not invented.
    let r = rule_from_sdk(
        0,
        &sdk_rule()
            .noncurrent_version_expiration(s3::NoncurrentVersionExpiration::builder().build())
            .abort_incomplete_multipart_upload(s3::AbortIncompleteMultipartUpload::builder().build())
            .build()
            .expect("r"),
    )
    .expect("f");
    assert_eq!(r.noncurrent_version_expiration, Some(NoncurrentExpiration::default()));
    assert_eq!(r.abort_incomplete_multipart_upload, Some(AbortIncompleteMultipartUpload::default()));
    // An empty rule list is "no configuration".
    assert_eq!(config_from_sdk(&[]).expect("empty"), None);
}

#[test]
fn unknown_values_from_the_server_are_refused_not_dropped() {
    let unknown_class = sdk_rule()
        .transitions(s3::Transition::builder().days(30).storage_class(s3::TransitionStorageClass::from("GLACIER_HOT")).build())
        .build()
        .expect("r");
    let e = rule_from_sdk(2, &unknown_class).expect_err("refused");
    assert_eq!(e.code, ErrorCode::Unknown);
    assert!(e.message.contains("the storage class “GLACIER_HOT” in rule 3 (“legacy”)"), "{}", e.message);
    assert!(e.message.contains("does not understand"), "{}", e.message);

    let unknown_nc = sdk_rule()
        .noncurrent_version_transitions(
            s3::NoncurrentVersionTransition::builder()
                .noncurrent_days(30)
                .storage_class(s3::TransitionStorageClass::from("FUTURE"))
                .build(),
        )
        .build()
        .expect("r");
    assert!(rule_from_sdk(0, &unknown_nc).expect_err("refused").message.contains("“FUTURE”"));

    let unknown_status = s3::LifecycleRule::builder()
        .id("s")
        .status(s3::ExpirationStatus::from("Paused"))
        .filter(s3::LifecycleRuleFilter::builder().build())
        .build()
        .expect("r");
    assert!(rule_from_sdk(0, &unknown_status).expect_err("refused").message.contains("the status “Paused”"));

    let no_class = sdk_rule().transitions(s3::Transition::builder().days(30).build()).build().expect("r");
    assert!(rule_from_sdk(0, &no_class).expect_err("refused").message.contains("without a storage class"));

    // One bad rule makes the whole configuration unreadable: no rule is dropped.
    let good = sdk_rule().build().expect("r");
    let e = config_from_sdk(&[good, unknown_class]).expect_err("refused");
    assert!(e.message.contains("rule 2"), "{}", e.message);
}

#[test]
fn json_shape_of_a_rule() {
    let r = LifecycleRule {
        id: "archive-logs".into(),
        status: RuleStatus::Enabled,
        filter: LifecycleFilter {
            prefix: Some("logs/".into()),
            tags: vec![t("env", "prod")],
            object_size_greater_than: n(1024),
            object_size_less_than: None,
        },
        transitions: vec![tr_days(30, C::StandardIa), tr_days(90, C::Glacier)],
        expiration: exp_days(365),
        noncurrent_version_transitions: vec![nct(30, Some(2), C::GlacierIr)],
        noncurrent_version_expiration: nce(90, None),
        abort_incomplete_multipart_upload: abort(7),
    };
    let v = serde_json::to_value(&r).expect("json");
    assert_eq!(
        v,
        json!({
            "id": "archive-logs",
            "status": "Enabled",
            "filter": {"prefix": "logs/", "tags": [{"key": "env", "value": "prod"}], "objectSizeGreaterThan": 1024, "objectSizeLessThan": null},
            "transitions": [
                {"days": 30, "date": null, "storageClass": "STANDARD_IA"},
                {"days": 90, "date": null, "storageClass": "GLACIER"}
            ],
            "expiration": {"days": 365, "date": null, "expiredObjectDeleteMarker": false},
            "noncurrentVersionTransitions": [{"noncurrentDays": 30, "newerNoncurrentVersions": 2, "storageClass": "GLACIER_IR"}],
            "noncurrentVersionExpiration": {"noncurrentDays": 90, "newerNoncurrentVersions": null},
            "abortIncompleteMultipartUpload": {"daysAfterInitiation": 7}
        })
    );
    // every storage class in S3's spelling
    for (c, s) in [
        (C::StandardIa, "STANDARD_IA"),
        (C::OnezoneIa, "ONEZONE_IA"),
        (C::IntelligentTiering, "INTELLIGENT_TIERING"),
        (C::GlacierIr, "GLACIER_IR"),
        (C::Glacier, "GLACIER"),
        (C::DeepArchive, "DEEP_ARCHIVE"),
    ] {
        assert_eq!(serde_json::to_value(c).expect("json"), json!(s));
        assert_eq!(c.as_str(), s);
        assert_eq!(class_to_sdk(c).as_str(), s);
    }
    assert_eq!(serde_json::to_value(RuleStatus::Disabled).expect("json"), json!("Disabled"));
    assert_eq!(serde_json::to_value(BucketVersioning::Off).expect("json"), json!("Off"));
    let issue = LifecycleIssue { rule_index: Some(1), field: Some("id".into()), message: "m".into() };
    assert_eq!(serde_json::to_value(issue).expect("json"), json!({"ruleIndex": 1, "field": "id", "message": "m"}));
    // What the UI sends with an empty form field (null) and a fractional number still parses.
    let lenient: LifecycleRule = serde_json::from_value(json!({
        "id": "x", "status": "Enabled",
        "filter": {"prefix": null, "tags": [], "objectSizeGreaterThan": 1.5, "objectSizeLessThan": null},
        "transitions": [], "expiration": null, "noncurrentVersionTransitions": [],
        "noncurrentVersionExpiration": {"noncurrentDays": null, "newerNoncurrentVersions": null},
        "abortIncompleteMultipartUpload": null
    }))
    .expect("parse");
    assert_eq!(lenient.filter.object_size_greater_than, f(1.5));
}

// ---- validation ----------------------------------------------------------------------------

#[test]
fn v_rule_count() {
    assert!(validate_lifecycle(&cfg(vec![])).is_empty(), "no rules is valid (saving deletes the configuration)");
    let many = |k: usize| cfg((0..k).map(|i| rule(&format!("r{i}"))).collect());
    assert!(validate_lifecycle(&many(1000)).is_empty());
    let i = validate_lifecycle(&many(1001));
    assert_eq!(i.len(), 1);
    assert_eq!((i[0].rule_index, i[0].field.as_deref()), (None, None));
    assert_eq!(i[0].message, "A lifecycle configuration can have at most 1,000 rules; this one has 1001.");
}

#[test]
fn v_id_length() {
    ok(rule("a"));
    ok(rule(&"x".repeat(255)));
    ok(rule(&"ж".repeat(255))); // counted in characters
    assert_eq!(bad(rule(""), Some("id"), "ID"), "Give the rule an ID (a name of up to 255 characters).");
    assert_eq!(bad(rule(&"x".repeat(256)), Some("id"), "256"), "The rule ID is 256 characters long; the limit is 255.");
}

#[test]
fn v_id_unique() {
    assert!(validate_lifecycle(&cfg(vec![rule("a"), rule("A"), rule("b")])).is_empty(), "case-sensitive");
    let i = validate_lifecycle(&cfg(vec![rule("a"), rule("b"), rule("a")]));
    assert_eq!(i.len(), 1);
    assert_eq!((i[0].rule_index, i[0].field.as_deref()), (Some(2), None));
    assert_eq!(i[0].message, "The rule ID “a” is already used by rule 1. Rule IDs must be unique.");
}

#[test]
fn v_at_least_one_action() {
    ok(LifecycleRule { expiration: None, abort_incomplete_multipart_upload: abort(1), ..rule("a") });
    ok(LifecycleRule { expiration: None, noncurrent_version_expiration: nce(1, None), ..rule("a") });
    ok(LifecycleRule { expiration: None, noncurrent_version_transitions: vec![nct(1, None, C::Glacier)], ..rule("a") });
    ok(LifecycleRule { expiration: None, transitions: vec![tr_days(1, C::Glacier)], ..rule("a") });
    bad(LifecycleRule { expiration: None, ..rule("a") }, None, "This rule does nothing");
}

#[test]
fn v_days_or_date_exactly_one() {
    ok(LifecycleRule { transitions: vec![tr_days(1, C::Glacier)], ..rule("a") });
    ok(LifecycleRule { transitions: vec![tr_date(JAN1, C::Glacier)], expiration: exp_date("2026-03-01T00:00:00Z"), ..rule("a") });
    let neither = LifecycleTransition { days: None, date: None, storage_class: C::Glacier };
    assert_eq!(
        bad(LifecycleRule { transitions: vec![neither], ..rule("a") }, Some("transitions[0].days"), "Choose"),
        "Choose when objects move to GLACIER: a number of days or a date."
    );
    let both = LifecycleTransition { days: n(10), date: Some(JAN1.into()), storage_class: C::Glacier };
    assert_eq!(
        bad(LifecycleRule { transitions: vec![both], ..rule("a") }, Some("transitions[0].days"), "both"),
        "The transition to GLACIER has both days and a date; use only one."
    );
    bad(
        LifecycleRule { expiration: Some(LifecycleExpiration::default()), ..rule("a") },
        Some("expiration.days"),
        "Choose when objects expire",
    );
    bad(
        LifecycleRule { expiration: Some(LifecycleExpiration { days: n(5), date: Some(JAN1.into()), ..Default::default() }), ..rule("a") },
        Some("expiration.days"),
        "The expiration has both days and a date",
    );
}

#[test]
fn v_days_positive_whole() {
    ok(LifecycleRule { expiration: exp_days(1), ..rule("a") });
    assert_eq!(
        bad(LifecycleRule { expiration: exp_days(0), ..rule("a") }, Some("expiration.days"), "1 or more"),
        "Days must be a whole number, 1 or more (it is 0)."
    );
    bad(LifecycleRule { expiration: exp_days(-4), ..rule("a") }, Some("expiration.days"), "1 or more (it is -4)");
    bad(
        LifecycleRule { expiration: Some(LifecycleExpiration { days: f(1.5), ..Default::default() }), ..rule("a") },
        Some("expiration.days"),
        "whole number, 1 or more (it is 1.5)",
    );
    bad(LifecycleRule { expiration: exp_days(i64::from(i32::MAX) + 1), ..rule("a") }, Some("expiration.days"), "at most 2147483647");
    // transitions may use day 0, but not less
    ok(LifecycleRule { transitions: vec![tr_days(0, C::Glacier)], ..rule("a") });
    assert_eq!(
        bad(LifecycleRule { transitions: vec![tr_days(-1, C::Glacier)], ..rule("a") }, Some("transitions[0].days"), "0 or more"),
        "Days must be a whole number, 0 or more (it is -1)."
    );
    bad(
        LifecycleRule { transitions: vec![LifecycleTransition { days: f(0.5), date: None, storage_class: C::Glacier }], ..rule("a") },
        Some("transitions[0].days"),
        "whole number, 0 or more (it is 0.5)",
    );
}

#[test]
fn v_date_midnight_utc() {
    ok(LifecycleRule { expiration: exp_date("2026-01-01"), ..rule("a") });
    ok(LifecycleRule { expiration: exp_date("2026-01-01T00:00:00.000Z"), ..rule("a") });
    assert_eq!(
        bad(LifecycleRule { expiration: exp_date("2026-01-01T12:00:00Z"), ..rule("a") }, Some("expiration.date"), "midnight"),
        "The date “2026-01-01T12:00:00Z” is not at midnight UTC; S3 only accepts dates at 00:00:00 UTC."
    );
    assert_eq!(
        bad(LifecycleRule { transitions: vec![tr_date("next tuesday", C::Glacier)], expiration: None, ..rule("a") }, Some("transitions[0].date"), "not a date"),
        "“next tuesday” is not a date. Use YYYY-MM-DD (midnight UTC)."
    );
}

#[test]
fn v_infrequent_access_minimum_30_days() {
    // Only STANDARD_IA and ONEZONE_IA have the 30-day minimum.
    for c in [C::StandardIa, C::OnezoneIa] {
        ok(LifecycleRule { transitions: vec![tr_days(30, c)], ..rule("a") });
        let m = bad(LifecycleRule { transitions: vec![tr_days(29, c)], ..rule("a") }, Some("transitions[0].days"), "at least 30 days");
        assert_eq!(m, format!("A transition to {} must be at least 30 days after creation (this one is after 29 days).", c.as_str()));
        bad(LifecycleRule { transitions: vec![tr_days(0, c)], ..rule("a") }, Some("transitions[0].days"), "(this one is on day 0)");
    }
    assert_eq!(
        bad(LifecycleRule { transitions: vec![tr_days(10, C::StandardIa)], ..rule("a") }, Some("transitions[0].days"), "at least 30"),
        "A transition to STANDARD_IA must be at least 30 days after creation (this one is after 10 days)."
    );
    // INTELLIGENT_TIERING and every archive class may move objects on day 0.
    for c in [C::IntelligentTiering, C::GlacierIr, C::Glacier, C::DeepArchive] {
        ok(LifecycleRule { transitions: vec![tr_days(0, c)], ..rule("a") });
        ok(LifecycleRule { transitions: vec![tr_days(1, c)], ..rule("a") });
    }
}

#[test]
fn v_distinct_storage_classes() {
    ok(LifecycleRule { transitions: vec![tr_days(10, C::GlacierIr), tr_days(20, C::Glacier)], ..rule("a") });
    let m = bad(
        LifecycleRule { transitions: vec![tr_days(10, C::Glacier), tr_days(20, C::Glacier)], ..rule("a") },
        Some("transitions[1].storageClass"),
        "already",
    );
    assert_eq!(m, "There is already a transition to GLACIER in this rule (transition 1). Each storage class can be used once.");
}

#[test]
fn v_strict_waterfall() {
    // STANDARD_IA -> INTELLIGENT_TIERING -> ONEZONE_IA -> GLACIER_IR -> GLACIER -> DEEP_ARCHIVE
    ok(LifecycleRule { transitions: vec![tr_days(30, C::StandardIa), tr_days(60, C::OnezoneIa)], ..rule("a") });
    ok(LifecycleRule { transitions: vec![tr_days(0, C::IntelligentTiering), tr_days(30, C::OnezoneIa)], ..rule("a") });
    ok(LifecycleRule { transitions: vec![tr_days(30, C::StandardIa), tr_days(31, C::IntelligentTiering)], ..rule("a") });
    ok(LifecycleRule {
        transitions: vec![
            tr_days(30, C::StandardIa),
            tr_days(45, C::IntelligentTiering),
            tr_days(60, C::OnezoneIa),
            tr_days(90, C::GlacierIr),
            tr_days(120, C::Glacier),
            tr_days(300, C::DeepArchive),
        ],
        expiration: exp_days(400),
        ..rule("a")
    });
    let m = bad(
        LifecycleRule { transitions: vec![tr_days(30, C::OnezoneIa), tr_days(60, C::StandardIa)], ..rule("a") },
        Some("transitions[0].days"),
        "ONEZONE_IA must come later",
    );
    assert_eq!(
        m,
        "Transition to ONEZONE_IA after 30 days comes before (or at the same time as) the transition to STANDARD_IA after 60 days: \
transitions follow S3's order STANDARD_IA → INTELLIGENT_TIERING → ONEZONE_IA → GLACIER_IR → GLACIER → DEEP_ARCHIVE, so ONEZONE_IA must come later."
    );
    bad(
        LifecycleRule { transitions: vec![tr_days(40, C::IntelligentTiering), tr_days(60, C::StandardIa)], ..rule("a") },
        Some("transitions[0].days"),
        "INTELLIGENT_TIERING must come later",
    );
    bad(
        LifecycleRule { transitions: vec![tr_days(30, C::OnezoneIa), tr_days(31, C::IntelligentTiering)], ..rule("a") },
        Some("transitions[0].days"),
        "ONEZONE_IA must come later",
    );
}

#[test]
fn v_only_colder() {
    // list order doesn't matter, time order does
    ok(LifecycleRule { transitions: vec![tr_days(90, C::Glacier), tr_days(30, C::StandardIa)], ..rule("a") });
    ok(LifecycleRule {
        transitions: vec![tr_days(30, C::StandardIa), tr_days(60, C::GlacierIr), tr_days(90, C::Glacier), tr_days(180, C::DeepArchive)],
        ..rule("a")
    });
    let m = bad(
        LifecycleRule { transitions: vec![tr_days(60, C::StandardIa), tr_days(40, C::Glacier)], ..rule("a") },
        Some("transitions[1].days"),
        "must come later",
    );
    assert_eq!(
        m,
        "Transition to GLACIER after 40 days comes before (or at the same time as) the transition to STANDARD_IA after 60 days: \
transitions follow S3's order STANDARD_IA → INTELLIGENT_TIERING → ONEZONE_IA → GLACIER_IR → GLACIER → DEEP_ARCHIVE, so GLACIER must come later."
    );
    // same time is not later
    bad(
        LifecycleRule { transitions: vec![tr_days(90, C::GlacierIr), tr_days(90, C::Glacier)], ..rule("a") },
        Some("transitions[1].days"),
        "at the same time",
    );
    // warmer later: DEEP_ARCHIVE at 100, GLACIER_IR at 200 -> reported on the colder one
    bad(
        LifecycleRule { transitions: vec![tr_days(100, C::DeepArchive), tr_days(200, C::GlacierIr)], expiration: exp_days(365), ..rule("a") },
        Some("transitions[0].days"),
        "DEEP_ARCHIVE must come later",
    );
    // dates too
    bad(
        LifecycleRule {
            transitions: vec![tr_date("2026-06-01", C::GlacierIr), tr_date("2026-05-01", C::DeepArchive)],
            expiration: None,
            ..rule("a")
        },
        Some("transitions[1].date"),
        "on 2026-05-01 comes before",
    );
}

#[test]
fn v_archive_30_days_after_infrequent_access() {
    ok(LifecycleRule { transitions: vec![tr_days(30, C::StandardIa), tr_days(60, C::Glacier)], ..rule("a") });
    let m = bad(
        LifecycleRule { transitions: vec![tr_days(30, C::StandardIa), tr_days(45, C::Glacier)], ..rule("a") },
        Some("transitions[1].days"),
        "30-day minimum",
    );
    assert_eq!(
        m,
        "Transition to GLACIER after 45 days comes before the 30-day minimum for the earlier STANDARD_IA transition (after 30 days): \
it must be after at least 60 days."
    );
    assert_eq!(
        bad(
            LifecycleRule { transitions: vec![tr_days(30, C::StandardIa), tr_days(50, C::Glacier)], ..rule("a") },
            Some("transitions[1].days"),
            "30-day minimum",
        ),
        "Transition to GLACIER after 50 days comes before the 30-day minimum for the earlier STANDARD_IA transition (after 30 days): it must be after at least 60 days."
    );
    bad(
        LifecycleRule { transitions: vec![tr_days(30, C::OnezoneIa), tr_days(31, C::GlacierIr)], ..rule("a") },
        Some("transitions[1].days"),
        "30-day minimum for the earlier ONEZONE_IA transition",
    );
    // no gap needed between two archive tiers
    ok(LifecycleRule { transitions: vec![tr_days(10, C::GlacierIr), tr_days(11, C::Glacier)], ..rule("a") });
    ok(LifecycleRule { transitions: vec![tr_days(0, C::Glacier), tr_days(90, C::DeepArchive)], ..rule("a") });
    // no gap needed after INTELLIGENT_TIERING
    ok(LifecycleRule { transitions: vec![tr_days(0, C::IntelligentTiering), tr_days(1, C::Glacier)], ..rule("a") });
    ok(LifecycleRule { transitions: vec![tr_days(30, C::IntelligentTiering), tr_days(31, C::DeepArchive)], ..rule("a") });
    // still strictly later
    bad(
        LifecycleRule { transitions: vec![tr_days(0, C::IntelligentTiering), tr_days(0, C::Glacier)], ..rule("a") },
        Some("transitions[1].days"),
        "GLACIER on day 0 comes before (or at the same time as) the transition to INTELLIGENT_TIERING on day 0",
    );
    // dates
    ok(LifecycleRule {
        transitions: vec![tr_date("2026-01-01", C::OnezoneIa), tr_date("2026-01-31", C::DeepArchive)],
        expiration: None,
        ..rule("a")
    });
    let m = bad(
        LifecycleRule {
            transitions: vec![tr_date("2026-01-01", C::OnezoneIa), tr_date("2026-01-30", C::DeepArchive)],
            expiration: None,
            ..rule("a")
        },
        Some("transitions[1].date"),
        "30-day minimum",
    );
    assert!(m.ends_with("it must be on 2026-01-31 or later."), "{m}");
}

#[test]
fn v_expiration_after_every_transition() {
    ok(LifecycleRule { transitions: vec![tr_days(30, C::StandardIa)], expiration: exp_days(31), ..rule("a") });
    let m = bad(
        LifecycleRule { transitions: vec![tr_days(30, C::StandardIa), tr_days(90, C::Glacier)], expiration: exp_days(90), ..rule("a") },
        Some("expiration.days"),
        "after every transition",
    );
    assert_eq!(m, "Expiration after 90 days must come after every transition; the transition to GLACIER is after 90 days.");
    ok(LifecycleRule { transitions: vec![tr_date("2026-01-01", C::Glacier)], expiration: exp_date("2026-01-02"), ..rule("a") });
    bad(
        LifecycleRule { transitions: vec![tr_date("2026-01-02", C::Glacier)], expiration: exp_date("2026-01-01"), ..rule("a") },
        Some("expiration.date"),
        "Expiration on 2026-01-01 must come after every transition",
    );
}

#[test]
fn v_days_and_dates_not_mixed() {
    let m = bad(
        LifecycleRule { transitions: vec![tr_days(30, C::StandardIa)], expiration: exp_date("2027-01-01"), ..rule("a") },
        Some("expiration.date"),
        "not a mix",
    );
    assert_eq!(m, "Use days for every transition and the expiration in this rule, or dates for all of them, not a mix.");
    bad(
        LifecycleRule { transitions: vec![tr_days(30, C::StandardIa), tr_date("2027-01-01", C::Glacier)], expiration: None, ..rule("a") },
        Some("transitions[1].date"),
        "not a mix",
    );
}

#[test]
fn v_expired_object_delete_marker() {
    ok(LifecycleRule { expiration: eodm(), ..rule("a") });
    ok(LifecycleRule { expiration: eodm(), filter: prefix("logs/"), ..rule("a") });
    let m = bad(
        LifecycleRule { expiration: Some(LifecycleExpiration { days: n(5), date: None, expired_object_delete_marker: true }), ..rule("a") },
        Some("expiration.expiredObjectDeleteMarker"),
        "can't be combined",
    );
    assert_eq!(m, "“Delete expired object delete markers” can't be combined with days or a date in the same expiration.");
    bad(
        LifecycleRule { expiration: Some(LifecycleExpiration { days: None, date: Some(JAN1.into()), expired_object_delete_marker: true }), ..rule("a") },
        Some("expiration.expiredObjectDeleteMarker"),
        "can't be combined",
    );
    let tagged = LifecycleFilter { tags: vec![t("k", "v")], ..Default::default() };
    let m = bad(LifecycleRule { expiration: eodm(), filter: tagged, ..rule("a") }, Some("expiration.expiredObjectDeleteMarker"), "tags or");
    assert_eq!(m, "“Delete expired object delete markers” can't be used in a rule whose filter has tags or object-size conditions.");
    for sized in [
        LifecycleFilter { object_size_greater_than: n(1), ..Default::default() },
        LifecycleFilter { object_size_less_than: n(10), ..Default::default() },
    ] {
        bad(LifecycleRule { expiration: eodm(), filter: sized, ..rule("a") }, Some("expiration.expiredObjectDeleteMarker"), "object-size");
    }
}

#[test]
fn v_abort_incomplete_multipart_upload() {
    ok(LifecycleRule { expiration: None, abort_incomplete_multipart_upload: abort(7), filter: prefix("up/"), ..rule("a") });
    let field = Some("abortIncompleteMultipartUpload.daysAfterInitiation");
    let m = bad(
        LifecycleRule { expiration: None, abort_incomplete_multipart_upload: abort(7), filter: LifecycleFilter { tags: vec![t("k", "v")], ..Default::default() }, ..rule("a") },
        field,
        "tags or",
    );
    assert_eq!(m, "Aborting incomplete multipart uploads can't be used in a rule whose filter has tags or object-size conditions.");
    bad(
        LifecycleRule { expiration: None, abort_incomplete_multipart_upload: abort(7), filter: LifecycleFilter { object_size_less_than: n(5), ..Default::default() }, ..rule("a") },
        field,
        "object-size",
    );
    bad(LifecycleRule { expiration: None, abort_incomplete_multipart_upload: abort(0), ..rule("a") }, field, "1 or more");
    bad(
        LifecycleRule { expiration: None, abort_incomplete_multipart_upload: Some(AbortIncompleteMultipartUpload::default()), ..rule("a") },
        field,
        "Enter after how many days",
    );
}

#[test]
fn v_object_size_range() {
    let sized = |gt: Option<Number>, lt: Option<Number>| LifecycleRule {
        filter: LifecycleFilter { object_size_greater_than: gt, object_size_less_than: lt, ..Default::default() },
        ..rule("a")
    };
    ok(sized(n(0), n(1)));
    ok(sized(n(1024), None));
    ok(sized(None, n(1)));
    let m = bad(sized(n(100), n(100)), Some("filter.objectSizeGreaterThan"), "must be less than");
    assert_eq!(m, "“Larger than” (100 bytes) must be less than “smaller than” (100 bytes), or no object can match.");
    bad(sized(n(200), n(100)), Some("filter.objectSizeGreaterThan"), "must be less than");
    bad(sized(n(-1), None), Some("filter.objectSizeGreaterThan"), "0 or more");
    bad(sized(f(1.5), None), Some("filter.objectSizeGreaterThan"), "whole number");
    bad(sized(None, n(0)), Some("filter.objectSizeLessThan"), "1 or more");
}

#[test]
fn v_filter_tags_follow_tag_limits() {
    let tagged = |tags: Vec<Tag>| LifecycleRule { filter: LifecycleFilter { tags, ..Default::default() }, ..rule("a") };
    ok(tagged(vec![t("env", "prod"), t("Env", "x"), t("team", "")]));
    ok(tagged(vec![t("team\u{00A0}name", "a\u{3000}b")])); // any \p{Z} space separator
    bad(tagged(vec![t("a\tb", "1")]), Some("filter.tags[0].key"), "aren't allowed");
    ok(tagged((0..10).map(|i| t(&format!("k{i}"), "v")).collect()));
    bad(tagged((0..11).map(|i| t(&format!("k{i}"), "v")).collect()), Some("filter.tags"), "at most 10 tags");
    bad(tagged(vec![t("ok", "1"), t("aws:x", "1")]), Some("filter.tags[1].key"), "reserved");
    bad(tagged(vec![t("", "1")]), Some("filter.tags[0].key"), "can't be empty");
    bad(tagged(vec![t("a*b", "1")]), Some("filter.tags[0].key"), "aren't allowed");
    bad(tagged(vec![t("k", "bad#value")]), Some("filter.tags[0].key"), "value of tag “k”");
    bad(tagged(vec![t(&"k".repeat(129), "")]), Some("filter.tags[0].key"), "limit is 128");
    let m = bad(tagged(vec![t("k", "1"), t("k", "2")]), Some("filter.tags[1].key"), "more than once");
    assert_eq!(m, "The tag key “k” is used more than once in this filter.");
}

#[test]
fn v_prefix_length() {
    ok(LifecycleRule { filter: prefix(&"p".repeat(1024)), ..rule("a") });
    ok(LifecycleRule { filter: prefix(""), ..rule("a") });
    let m = bad(LifecycleRule { filter: prefix(&"é".repeat(513)), ..rule("a") }, Some("filter.prefix"), "1026 bytes");
    assert_eq!(m, "The prefix is 1026 bytes long; the limit is 1024 bytes (UTF-8).");
}

#[test]
fn v_whole_bucket_rule_is_allowed() {
    ok(rule("everything"));
}

#[test]
fn v_noncurrent_days_and_versions() {
    let r = |t: Vec<NoncurrentTransition>, e: Option<NoncurrentExpiration>| LifecycleRule {
        expiration: None,
        noncurrent_version_transitions: t,
        noncurrent_version_expiration: e,
        ..rule("a")
    };
    ok(r(vec![nct(1, Some(1), C::Glacier)], nce(2, Some(100))));
    bad(r(vec![nct(0, None, C::Glacier)], None), Some("noncurrentVersionTransitions[0].noncurrentDays"), "1 or more");
    bad(
        r(vec![NoncurrentTransition { noncurrent_days: None, newer_noncurrent_versions: None, storage_class: C::Glacier }], None),
        Some("noncurrentVersionTransitions[0].noncurrentDays"),
        "Enter how many days",
    );
    bad(r(vec![nct(5, Some(0), C::Glacier)], None), Some("noncurrentVersionTransitions[0].newerNoncurrentVersions"), "1 or more");
    let m = bad(r(vec![nct(5, Some(101), C::Glacier)], None), Some("noncurrentVersionTransitions[0].newerNoncurrentVersions"), "at most 100");
    assert_eq!(m, "Versions to keep must be at most 100 (it is 101).");
    bad(r(vec![], nce(0, None)), Some("noncurrentVersionExpiration.noncurrentDays"), "1 or more");
    bad(r(vec![], Some(NoncurrentExpiration::default())), Some("noncurrentVersionExpiration.noncurrentDays"), "Enter how many days");
    bad(r(vec![], nce(5, Some(101))), Some("noncurrentVersionExpiration.newerNoncurrentVersions"), "at most 100");
    bad(r(vec![], Some(NoncurrentExpiration { noncurrent_days: f(2.5), newer_noncurrent_versions: None })), Some("noncurrentVersionExpiration.noncurrentDays"), "whole");
}

#[test]
fn v_noncurrent_order() {
    let r = |t: Vec<NoncurrentTransition>, e: Option<NoncurrentExpiration>| LifecycleRule {
        expiration: None,
        noncurrent_version_transitions: t,
        noncurrent_version_expiration: e,
        ..rule("a")
    };
    ok(r(vec![nct(30, None, C::StandardIa), nct(40, None, C::Glacier)], nce(41, None)));
    bad(
        r(vec![nct(30, None, C::Glacier), nct(30, None, C::Glacier)], None),
        Some("noncurrentVersionTransitions[1].storageClass"),
        "already a noncurrent-version transition to GLACIER",
    );
    bad(
        r(vec![nct(60, None, C::StandardIa), nct(30, None, C::Glacier)], None),
        Some("noncurrentVersionTransitions[1].noncurrentDays"),
        "must come later",
    );
    let m = bad(
        r(vec![nct(30, None, C::Glacier)], nce(30, None)),
        Some("noncurrentVersionExpiration.noncurrentDays"),
        "after every transition",
    );
    assert_eq!(
        m,
        "Noncurrent versions are deleted after 30 days but the noncurrent-version transition to GLACIER is after 30 days; \
deletion must come after every transition."
    );
}

#[test]
fn v_real_world_configuration_is_valid() {
    let c = cfg(vec![
        // legacy prefix rule read from the server
        rule_from_sdk(0, &sdk_rule().id("old-logs").prefix("logs/").build().expect("r")).expect("from"),
        LifecycleRule {
            filter: LifecycleFilter { prefix: Some("data/".into()), tags: vec![t("env", "prod")], ..Default::default() },
            transitions: vec![tr_days(30, C::StandardIa), tr_days(90, C::GlacierIr), tr_days(180, C::DeepArchive)],
            expiration: exp_days(2555),
            ..rule("archive-prod")
        },
        LifecycleRule {
            filter: LifecycleFilter { object_size_greater_than: n(128 * 1024), object_size_less_than: n(5 << 30), ..Default::default() },
            transitions: vec![tr_days(30, C::IntelligentTiering)],
            expiration: None,
            ..rule("big-to-it")
        },
        LifecycleRule {
            expiration: eodm(),
            noncurrent_version_transitions: vec![nct(30, Some(3), C::StandardIa)],
            noncurrent_version_expiration: nce(90, Some(3)),
            abort_incomplete_multipart_upload: abort(7),
            ..rule("hygiene")
        },
        LifecycleRule { status: RuleStatus::Disabled, filter: prefix("tmp/"), expiration: exp_date("2027-01-01T00:00:00Z"), ..rule("tmp-cutoff") },
    ]);
    assert_eq!(validate_lifecycle(&c), vec![]);
}

#[test]
fn v_issues_message_lists_issues() {
    let c = cfg(vec![rule("ok"), LifecycleRule { expiration: exp_days(0), ..rule("bad") }, rule("ok")]);
    let i = validate_lifecycle(&c);
    assert_eq!(i.len(), 2);
    assert_eq!(
        issues_message(&c, &i),
        "The lifecycle configuration was not saved because it has 2 problems: Rule 2 (“bad”): Days must be a whole number, \
1 or more (it is 0). Rule 3 (“ok”): The rule ID “ok” is already used by rule 1. Rule IDs must be unique."
    );
}

// ---- semantic comparison -------------------------------------------------------------------

#[test]
fn same_after_normalization() {
    let a = LifecycleRule {
        filter: LifecycleFilter { prefix: Some(String::new()), tags: vec![t("b", "2"), t("a", "1")], object_size_greater_than: f(10.0), ..Default::default() },
        transitions: vec![tr_days(90, C::Glacier), tr_days(30, C::StandardIa)],
        expiration: exp_date("2027-01-01"),
        noncurrent_version_transitions: vec![nct(60, None, C::Glacier), nct(30, Some(2), C::StandardIa)],
        ..rule("r")
    };
    let b = LifecycleRule {
        filter: LifecycleFilter { prefix: None, tags: vec![t("a", "1"), t("b", "2")], object_size_greater_than: n(10), ..Default::default() },
        transitions: vec![tr_days(30, C::StandardIa), tr_days(90, C::Glacier)],
        expiration: exp_date("2027-01-01T00:00:00.000Z"),
        noncurrent_version_transitions: vec![nct(30, Some(2), C::StandardIa), nct(60, None, C::Glacier)],
        ..rule("r")
    };
    assert!(same_configuration(Some(&cfg(vec![a.clone()])), Some(&cfg(vec![b.clone()]))));
    // and the SDK round trip of either is the same
    let via_sdk = rule_from_sdk(0, &rule_to_sdk(&a).expect("to")).expect("from");
    assert!(same_configuration(Some(&cfg(vec![via_sdk])), Some(&cfg(vec![b]))));
}

#[test]
fn rule_order_matters() {
    let (x, y) = (rule("x"), rule("y"));
    assert!(same_configuration(Some(&cfg(vec![x.clone(), y.clone()])), Some(&cfg(vec![x.clone(), y.clone()]))));
    assert!(!same_configuration(Some(&cfg(vec![x.clone(), y.clone()])), Some(&cfg(vec![y, x]))));
}

#[test]
fn real_differences_are_different() {
    let base = cfg(vec![rule("x")]);
    let changes = [
        LifecycleRule { status: RuleStatus::Disabled, ..rule("x") },
        LifecycleRule { id: "X".into(), ..rule("x") },
        LifecycleRule { expiration: exp_days(366), ..rule("x") },
        LifecycleRule { filter: prefix("a/"), ..rule("x") },
        LifecycleRule { filter: LifecycleFilter { tags: vec![t("k", "v")], ..Default::default() }, ..rule("x") },
        LifecycleRule { transitions: vec![tr_days(30, C::StandardIa)], ..rule("x") },
        LifecycleRule { abort_incomplete_multipart_upload: abort(1), ..rule("x") },
        LifecycleRule { noncurrent_version_expiration: nce(1, None), ..rule("x") },
        LifecycleRule { expiration: Some(LifecycleExpiration { days: n(365), date: None, expired_object_delete_marker: true }), ..rule("x") },
    ];
    for c in changes {
        assert!(!same_configuration(Some(&base), Some(&cfg(vec![c.clone()]))), "{c:?}");
    }
    assert!(!same_configuration(Some(&base), Some(&cfg(vec![rule("x"), rule("y")]))));
}

#[test]
fn none_and_empty_are_the_same() {
    assert!(same_configuration(None, None));
    assert!(same_configuration(None, Some(&cfg(vec![]))));
    assert!(!same_configuration(None, Some(&cfg(vec![rule("x")]))));
    assert!(!same_configuration(Some(&cfg(vec![rule("x")])), None));
}

#[test]
fn differences_name_the_fields() {
    let sent = cfg(vec![
        LifecycleRule { transitions: vec![tr_days(30, C::StandardIa)], expiration: exp_days(60), ..rule("a") },
        rule("b"),
    ]);
    let stored = cfg(vec![LifecycleRule { expiration: exp_days(60), ..rule("a") }, rule("b")]);
    assert_eq!(differences(&sent, Some(&stored)), vec!["rule 1 (“a”): transitions".to_string()]);
    assert_eq!(differences(&sent, None), vec!["it stored 0 rules instead of 2".to_string()]);
    assert!(differences(&sent, Some(&sent)).is_empty());
}

#[test]
fn versioning_status() {
    assert_eq!(versioning_from_sdk(None).expect("off"), BucketVersioning::Off);
    assert_eq!(versioning_from_sdk(Some(&s3::BucketVersioningStatus::Enabled)).expect("on"), BucketVersioning::Enabled);
    assert_eq!(versioning_from_sdk(Some(&s3::BucketVersioningStatus::Suspended)).expect("s"), BucketVersioning::Suspended);
    assert!(versioning_from_sdk(Some(&s3::BucketVersioningStatus::from("Weird"))).is_err());
}

// ---- past dates (non-blocking note) --------------------------------------------------------

#[test]
fn v_past_date_is_a_note_not_an_error() {
    // NOW is 2025-06-01: that day itself and earlier are "today or in the past".
    for d in ["2025-06-01", "2024-01-01T00:00:00Z"] {
        let i = issues_of(LifecycleRule { expiration: exp_date(d), ..rule("a") });
        assert_eq!(i.len(), 1, "{i:#?}");
        assert_eq!(i[0].field.as_deref(), Some("expiration.date"));
        assert_eq!(
            i[0].message,
            "Note: this date is today or in the past, so every matching object, and every new one, is deleted at the next daily run."
        );
    }
    let i = issues_of(LifecycleRule { transitions: vec![tr_date("2025-01-01", C::Glacier)], expiration: None, ..rule("a") });
    assert_eq!(i.len(), 1);
    assert_eq!(i[0].field.as_deref(), Some("transitions[0].date"));
    assert!(i[0].message.starts_with(NOTE_PREFIX) && i[0].message.contains("is moved at the next daily run"), "{}", i[0].message);
    ok(LifecycleRule { expiration: exp_date("2025-06-02"), ..rule("a") });
}

// ---- put_lifecycle against a scripted server (read-back, lag, rollback) ----------------------

mod server {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::*;
    use crate::testutil::{FakeS3, Reply};

    /// One stored rule as S3 XML: id, prefix, expiration days, optional noncurrent expiration.
    fn xml_rule(id: &str, prefix: &str, days: i64, nce: Option<i64>) -> String {
        let nce = nce
            .map(|d| format!("<NoncurrentVersionExpiration><NoncurrentDays>{d}</NoncurrentDays></NoncurrentVersionExpiration>"))
            .unwrap_or_default();
        format!(
            "<Rule><ID>{id}</ID><Filter><Prefix>{prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>{days}</Days></Expiration>{nce}</Rule>"
        )
    }
    fn xml(rules: &[String]) -> Option<String> {
        Some(format!(r#"<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration>{}</LifecycleConfiguration>"#, rules.concat()))
    }
    fn model(id: &str, prefix_: &str, days: i64, nce_days: Option<i64>) -> LifecycleRule {
        LifecycleRule {
            filter: prefix(prefix_),
            expiration: exp_days(days),
            noncurrent_version_expiration: nce_days.and_then(|d| nce(d, None)),
            ..rule(id)
        }
    }

    type Get = Result<Option<String>, u16>;

    /// Answers GETs from `gets` in order (the last one repeats; `Ok(None)` = no configuration,
    /// `Err(403)` = AccessDenied); PUT and DELETE succeed when `write` is 200, else are refused.
    async fn server(gets: Vec<Get>, write: u16) -> FakeS3 {
        let q = Arc::new(Mutex::new(VecDeque::from(gets)));
        FakeS3::start(move |r| match r.method.as_str() {
            "GET" => {
                let mut q = q.lock().unwrap_or_else(|p| p.into_inner());
                let next = if q.len() > 1 { q.pop_front() } else { q.front().cloned() };
                match next {
                    Some(Ok(Some(body))) => Reply::xml(200, &body),
                    Some(Ok(None)) => {
                        Reply::xml(404, "<Error><Code>NoSuchLifecycleConfiguration</Code><Message>none</Message></Error>")
                    }
                    Some(Err(403)) => Reply::xml(403, "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"),
                    _ => Reply::status(500),
                }
            }
            "PUT" if write == 200 => Reply::status(200),
            "DELETE" if write == 200 => Reply::status(204),
            _ => Reply::xml(400, "<Error><Code>InvalidRequest</Code><Message>refused</Message></Error>"),
        })
        .await
    }

    fn fast() -> Vec<Duration> {
        vec![Duration::ZERO, Duration::from_millis(5), Duration::from_millis(5), Duration::from_millis(5)]
    }
    fn puts(s3: &FakeS3) -> usize {
        s3.count(|r| r.method == "PUT")
    }
    fn deletes(s3: &FakeS3) -> usize {
        s3.count(|r| r.method == "DELETE")
    }

    fn old() -> (LifecycleConfiguration, Option<String>) {
        (cfg(vec![model("old", "logs/", 365, None)]), xml(&[xml_rule("old", "logs/", 365, None)]))
    }
    fn new() -> (LifecycleConfiguration, Option<String>) {
        (cfg(vec![model("new", "tmp/", 400, Some(30))]), xml(&[xml_rule("new", "tmp/", 400, Some(30))]))
    }

    #[tokio::test]
    async fn stale_read_after_put_is_lag_not_a_drop() {
        let ((a, ax), (b, bx)) = (old(), new());
        // pre-check A, read-back A (stale), then B
        let s3 = server(vec![Ok(ax.clone()), Ok(ax), Ok(bx)], 200).await;
        let got = put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect("saved");
        assert_eq!(got, Some(b));
        assert_eq!((puts(&s3), deletes(&s3)), (1, 0), "nothing was put back");
    }

    #[tokio::test]
    async fn stale_read_after_delete_is_lag() {
        let (a, ax) = old();
        let s3 = server(vec![Ok(ax.clone()), Ok(ax), Ok(None)], 200).await;
        let got = put_lifecycle_with(&s3.client(), "b", &cfg(vec![]), Some(&a), &fast()).await.expect("deleted");
        assert_eq!(got, None);
        assert_eq!((puts(&s3), deletes(&s3)), (0, 1), "no PUT restoring the deleted rule");
    }

    #[tokio::test]
    async fn lag_that_never_resolves_is_not_a_drop() {
        let ((a, ax), (b, _)) = (old(), new());
        let s3 = server(vec![Ok(ax)], 200).await;
        let e = put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect_err("unconfirmed");
        assert!(e.message.starts_with("Saved, but reading back failed: after about 20 seconds"), "{}", e.message);
        assert_eq!(puts(&s3), 1, "nothing put back");
    }

    #[tokio::test]
    async fn a_dropped_field_seen_twice_is_put_back() {
        let ((a, ax), (b, _)) = (old(), new());
        let dropped = xml(&[xml_rule("new", "tmp/", 400, None)]);
        // pre-check A; read-back B-without-nce twice; after the restore PUT, A.
        let s3 = server(vec![Ok(ax.clone()), Ok(dropped.clone()), Ok(dropped), Ok(ax)], 200).await;
        let e = put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect_err("dropped");
        assert_eq!(e.code, ErrorCode::NotSupported);
        assert!(e.message.contains("rule 1 (“new”): noncurrent-version expiration"), "{}", e.message);
        assert!(e.message.ends_with("The previous configuration was put back, so nothing changed."), "{}", e.message);
        assert_eq!(puts(&s3), 2, "the write and the restore");
        let restore =
            s3.requests().into_iter().filter(|r| r.method == "PUT").nth(1).map(|r| String::from_utf8_lossy(&r.body).to_string());
        assert!(restore.unwrap_or_default().contains("<ID>old</ID>"));
    }

    #[tokio::test]
    async fn a_different_read_once_then_the_target_is_saved() {
        let ((a, ax), (b, bx)) = (old(), new());
        let dropped = xml(&[xml_rule("new", "tmp/", 400, None)]);
        let s3 = server(vec![Ok(ax), Ok(dropped), Ok(bx)], 200).await;
        assert_eq!(put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect("saved"), Some(b));
        assert_eq!(puts(&s3), 1);
    }

    #[tokio::test]
    async fn someone_elses_rules_are_never_overwritten_by_a_restore() {
        let ((a, ax), (b, _)) = (old(), new());
        let theirs = xml(&[xml_rule("theirs", "x/", 10, None)]);
        let s3 = server(vec![Ok(ax), Ok(theirs.clone()), Ok(theirs)], 200).await;
        let e = put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect_err("changed");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Conflict, CHANGED_AFTER_SAVE));
        assert_eq!(puts(&s3), 1);
    }

    #[tokio::test]
    async fn write_error_but_stored_after_all_is_success() {
        let ((a, ax), (b, bx)) = (old(), new());
        let s3 = server(vec![Ok(ax), Ok(bx)], 400).await;
        assert_eq!(put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect("saved"), Some(b));
        // and a refused write that changed nothing says so
        let ((a, ax), (b, _)) = (old(), new());
        let s3 = server(vec![Ok(ax)], 400).await;
        let e = put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect_err("refused");
        assert_eq!(e.message, "The server refused the lifecycle configuration (InvalidRequest: refused). Nothing was changed.");
    }

    #[tokio::test]
    async fn failed_read_back_after_a_successful_write() {
        let ((a, ax), (b, _)) = (old(), new());
        let s3 = server(vec![Ok(ax), Err(403)], 200).await;
        let e = put_lifecycle_with(&s3.client(), "b", &b, Some(&a), &fast()).await.expect_err("read-back fails");
        assert_eq!(e.code, ErrorCode::AccessDenied);
        assert_eq!(e.message, "Saved, but reading back failed: AccessDenied: Access Denied. Reload to see the current state.");
        assert_eq!(puts(&s3), 1);
    }

    #[tokio::test]
    async fn a_past_date_note_does_not_block_saving() {
        let c = cfg(vec![LifecycleRule { expiration: exp_date("2020-01-01T00:00:00Z"), ..rule("past") }]);
        let issues = crate::lifecycle::validate_lifecycle(&c);
        assert!(!issues.is_empty() && issues.iter().all(|i| i.message.starts_with(NOTE_PREFIX)), "{issues:?}");
        let stored = xml(&[
            "<Rule><ID>past</ID><Filter></Filter><Status>Enabled</Status><Expiration><Date>2020-01-01T00:00:00Z</Date></Expiration></Rule>"
                .to_string(),
        ]);
        let s3 = server(vec![Ok(None), Ok(stored)], 200).await;
        assert_eq!(put_lifecycle_with(&s3.client(), "b", &c, None, &fast()).await.expect("saved"), Some(c));
    }
}
