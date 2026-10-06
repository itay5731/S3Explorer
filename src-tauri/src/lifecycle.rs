//! Bucket lifecycle configuration: the two-way mapping between our model (`LifecycleRule` in
//! `types.ts`) and the SDK's, validation, semantic comparison, and the S3 calls.
//!
//! S3 stores lifecycle as one document and `PutBucketLifecycleConfiguration` replaces every rule,
//! and a rule can delete a whole bucket's contents a day after it is saved. So:
//! - the mapping covers every field of the SDK type and refuses (rather than drops) anything this
//!   version does not understand (an unknown storage class or status, a malformed filter);
//! - a write is refused when the stored configuration differs from the one the UI loaded;
//! - after a write the stored configuration is read back and compared with what was sent; a
//!   server that silently drops parts of it gets the previous configuration put back.
//!
//! No Tauri types here.

use std::collections::HashMap;
use std::time::Duration;

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::types as s3;
use aws_sdk_s3::Client;
use aws_smithy_types::date_time::Format;
use aws_smithy_types::DateTime as SdkDateTime;
use serde_json::Number;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{
    AbortIncompleteMultipartUpload, BucketVersioning, LifecycleConfiguration, LifecycleExpiration, LifecycleFilter,
    LifecycleIssue, LifecycleRule, LifecycleTransition, NoncurrentExpiration, NoncurrentTransition, RuleStatus,
    StorageClass, Tag,
};
use crate::tags;

/// `LIFECYCLE_LIMITS` in `types.ts`.
pub const MAX_RULES: usize = 1000;
pub const RULE_ID_MAX_CHARS: usize = 255;
/// Minimum days before a transition to STANDARD_IA or ONEZONE_IA (INTELLIGENT_TIERING and the
/// archive classes may use day 0).
pub const MIN_DAYS_TO_INFREQUENT_ACCESS: i64 = 30;
/// Minimum gap between a STANDARD_IA / ONEZONE_IA transition and a later archive transition.
pub const MIN_DAYS_BETWEEN_TIERS: i64 = 30;
pub const NEWER_NONCURRENT_MIN: i64 = 1;
pub const NEWER_NONCURRENT_MAX: i64 = 100;
/// An S3 key (and so a prefix) is at most 1,024 bytes of UTF-8.
pub const PREFIX_MAX_BYTES: usize = 1024;
/// An object has at most 10 tags, so a filter with more could never match.
pub const FILTER_MAX_TAGS: usize = tags::OBJECT_MAX_TAGS;

const DAY_SECS: i64 = 86_400;
/// Largest integer an `f64` (a JavaScript number) represents exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;

pub const CONFLICT: &str = "The bucket's lifecycle configuration was changed by someone else since it was loaded. \
Nothing was saved. Reload to see the current rules.";

// ---- numbers and dates ---------------------------------------------------------------------

/// The whole-number value of a JSON number (`30`, also `30.0`), `None` for `1.5` or out of range.
pub fn int_of(n: &Number) -> Option<i64> {
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    if n.is_u64() {
        return None; // above i64::MAX
    }
    let f = n.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER).then_some(f as i64)
}

fn num(i: i64) -> Number {
    Number::from(i)
}

/// Seconds since the epoch of an ISO-8601 date at midnight UTC. Accepts `YYYY-MM-DD` and RFC 3339
/// date-times (`2026-01-01T00:00:00Z`, `2026-01-01T00:00:00.000Z`, or an offset that is still
/// midnight UTC). `Err` is the user-facing reason.
pub fn parse_midnight(s: &str) -> Result<i64, String> {
    let t = s.trim();
    if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        if t.len() == 10 {
            return d.and_hms_opt(0, 0, 0).map(|x| x.and_utc().timestamp()).ok_or_else(|| bad_date(s));
        }
    }
    let dt = chrono::DateTime::parse_from_rfc3339(t).map_err(|_| bad_date(s))?.with_timezone(&chrono::Utc);
    use chrono::Timelike;
    if dt.num_seconds_from_midnight() != 0 || dt.nanosecond() != 0 {
        return Err(format!("The date “{s}” is not at midnight UTC; S3 only accepts dates at 00:00:00 UTC."));
    }
    Ok(dt.timestamp())
}

fn bad_date(s: &str) -> String {
    format!("“{s}” is not a date. Use YYYY-MM-DD (midnight UTC).")
}

/// The canonical text of a date: `2026-01-01T00:00:00Z`.
pub fn format_secs(secs: i64) -> String {
    SdkDateTime::from_secs(secs).fmt(Format::DateTime).unwrap_or_else(|_| secs.to_string())
}

fn ymd(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_else(|| secs.to_string())
}

fn days_text(n: i64) -> String {
    if n == 1 {
        "1 day".to_string()
    } else {
        format!("{n} days")
    }
}

// ---- SDK -> model --------------------------------------------------------------------------

fn rule_label(index: usize, id: &str) -> String {
    if id.is_empty() {
        format!("rule {}", index + 1)
    } else {
        format!("rule {} (“{id}”)", index + 1)
    }
}

/// The configuration read from the server uses something this version cannot represent.
fn not_understood(index: usize, id: &str, what: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::Unknown,
        format!(
            "This bucket's lifecycle configuration uses {what} in {}, which this version of S3 Explorer does not \
understand. To avoid losing it, the configuration can't be shown or changed here; use the AWS console or CLI.",
            rule_label(index, id)
        ),
    )
}

fn class_from_sdk(c: &s3::TransitionStorageClass, index: usize, id: &str) -> AppResult<StorageClass> {
    Ok(match c {
        s3::TransitionStorageClass::StandardIa => StorageClass::StandardIa,
        s3::TransitionStorageClass::OnezoneIa => StorageClass::OnezoneIa,
        s3::TransitionStorageClass::IntelligentTiering => StorageClass::IntelligentTiering,
        s3::TransitionStorageClass::GlacierIr => StorageClass::GlacierIr,
        s3::TransitionStorageClass::Glacier => StorageClass::Glacier,
        s3::TransitionStorageClass::DeepArchive => StorageClass::DeepArchive,
        other => return Err(not_understood(index, id, format_args!("the storage class “{}”", other.as_str()))),
    })
}

fn class_to_sdk(c: StorageClass) -> s3::TransitionStorageClass {
    match c {
        StorageClass::StandardIa => s3::TransitionStorageClass::StandardIa,
        StorageClass::OnezoneIa => s3::TransitionStorageClass::OnezoneIa,
        StorageClass::IntelligentTiering => s3::TransitionStorageClass::IntelligentTiering,
        StorageClass::GlacierIr => s3::TransitionStorageClass::GlacierIr,
        StorageClass::Glacier => s3::TransitionStorageClass::Glacier,
        StorageClass::DeepArchive => s3::TransitionStorageClass::DeepArchive,
    }
}

fn date_from_sdk(d: &SdkDateTime, index: usize, id: &str) -> AppResult<String> {
    d.fmt(Format::DateTime).map_err(|_| not_understood(index, id, "a date out of range"))
}

fn tags_from_sdk(t: &[s3::Tag]) -> Vec<Tag> {
    t.iter().map(|t| Tag::new(t.key(), t.value())).collect()
}

fn filter_from_sdk(f: &s3::LifecycleRuleFilter, index: usize, id: &str) -> AppResult<LifecycleFilter> {
    let direct = f.prefix.is_some() || f.tag.is_some() || f.object_size_greater_than.is_some() || f.object_size_less_than.is_some();
    if let Some(and) = &f.and {
        if direct {
            return Err(not_understood(index, id, "a filter with both And and other conditions"));
        }
        return Ok(LifecycleFilter {
            prefix: and.prefix.clone(),
            tags: and.tags.as_deref().map(tags_from_sdk).unwrap_or_default(),
            object_size_greater_than: and.object_size_greater_than.map(num),
            object_size_less_than: and.object_size_less_than.map(num),
        });
    }
    // Several direct conditions are invalid in S3 (they belong in And) but have one meaning: all
    // of them. Keep every one rather than drop any.
    Ok(LifecycleFilter {
        prefix: f.prefix.clone(),
        tags: f.tag.as_ref().map(|t| vec![Tag::new(t.key(), t.value())]).unwrap_or_default(),
        object_size_greater_than: f.object_size_greater_than.map(num),
        object_size_less_than: f.object_size_less_than.map(num),
    })
}

/// One SDK rule as our model. Every field is carried; an unknown enum value or a filter shape
/// with no faithful representation is an error naming it (never a silent drop).
// Reads the deprecated top-level `Prefix` on purpose: legacy rules still carry it.
#[allow(deprecated)]
pub fn rule_from_sdk(index: usize, r: &s3::LifecycleRule) -> AppResult<LifecycleRule> {
    let id = r.id.clone().unwrap_or_default();
    let status = match &r.status {
        s3::ExpirationStatus::Enabled => RuleStatus::Enabled,
        s3::ExpirationStatus::Disabled => RuleStatus::Disabled,
        other => return Err(not_understood(index, &id, format_args!("the status “{}”", other.as_str()))),
    };
    let filter = match (&r.prefix, &r.filter) {
        // Legacy rule: a top-level Prefix and no Filter.
        (Some(p), None) => LifecycleFilter { prefix: Some(p.clone()), ..Default::default() },
        (None, Some(f)) => filter_from_sdk(f, index, &id)?,
        (Some(p), Some(f)) => {
            let g = filter_from_sdk(f, index, &id)?;
            if g == LifecycleFilter::default() {
                LifecycleFilter { prefix: Some(p.clone()), ..Default::default() }
            } else {
                return Err(not_understood(index, &id, "both a top-level Prefix and a Filter"));
            }
        }
        (None, None) => LifecycleFilter::default(),
    };
    let transitions = r
        .transitions
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|t| {
            let class = t
                .storage_class
                .as_ref()
                .ok_or_else(|| not_understood(index, &id, "a transition without a storage class"))?;
            Ok(LifecycleTransition {
                days: t.days.map(|d| num(d.into())),
                date: t.date.as_ref().map(|d| date_from_sdk(d, index, &id)).transpose()?,
                storage_class: class_from_sdk(class, index, &id)?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let expiration = r
        .expiration
        .as_ref()
        .map(|e| {
            Ok::<_, AppError>(LifecycleExpiration {
                days: e.days.map(|d| num(d.into())),
                date: e.date.as_ref().map(|d| date_from_sdk(d, index, &id)).transpose()?,
                expired_object_delete_marker: e.expired_object_delete_marker.unwrap_or(false),
            })
        })
        .transpose()?;
    let noncurrent_version_transitions = r
        .noncurrent_version_transitions
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|t| {
            let class = t
                .storage_class
                .as_ref()
                .ok_or_else(|| not_understood(index, &id, "a noncurrent-version transition without a storage class"))?;
            Ok(NoncurrentTransition {
                noncurrent_days: t.noncurrent_days.map(|d| num(d.into())),
                newer_noncurrent_versions: t.newer_noncurrent_versions.map(|d| num(d.into())),
                storage_class: class_from_sdk(class, index, &id)?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let noncurrent_version_expiration = r.noncurrent_version_expiration.as_ref().map(|e| NoncurrentExpiration {
        noncurrent_days: e.noncurrent_days.map(|d| num(d.into())),
        newer_noncurrent_versions: e.newer_noncurrent_versions.map(|d| num(d.into())),
    });
    let abort_incomplete_multipart_upload = r
        .abort_incomplete_multipart_upload
        .as_ref()
        .map(|a| AbortIncompleteMultipartUpload { days_after_initiation: a.days_after_initiation.map(|d| num(d.into())) });
    Ok(LifecycleRule {
        id,
        status,
        filter,
        transitions,
        expiration,
        noncurrent_version_transitions,
        noncurrent_version_expiration,
        abort_incomplete_multipart_upload,
    })
}

/// The rules read from the server; `None` when there are none (S3 has no empty configuration).
pub fn config_from_sdk(rules: &[s3::LifecycleRule]) -> AppResult<Option<LifecycleConfiguration>> {
    if rules.is_empty() {
        return Ok(None);
    }
    let rules = rules.iter().enumerate().map(|(i, r)| rule_from_sdk(i, r)).collect::<AppResult<Vec<_>>>()?;
    Ok(Some(LifecycleConfiguration { rules }))
}

// ---- model -> SDK --------------------------------------------------------------------------

fn i32_of(n: &Number, what: &str) -> AppResult<i32> {
    int_of(n)
        .and_then(|i| i32::try_from(i).ok())
        .ok_or_else(|| AppError::invalid(format!("{what} must be a whole number of days (got {n}).")))
}

fn i64_of(n: &Number, what: &str) -> AppResult<i64> {
    int_of(n).ok_or_else(|| AppError::invalid(format!("{what} must be a whole number (got {n}).")))
}

fn date_to_sdk(s: &str) -> AppResult<SdkDateTime> {
    parse_midnight(s).map(SdkDateTime::from_secs).map_err(AppError::invalid)
}

fn tag_to_sdk(t: &Tag) -> AppResult<s3::Tag> {
    s3::Tag::builder().key(&t.key).value(&t.value).build().map_err(|e| AppError::invalid(format!("Invalid tag: {e}")))
}

/// No condition: `Filter {}` (whole bucket); one: that condition directly; several: `And`.
pub fn filter_to_sdk(f: &LifecycleFilter) -> AppResult<s3::LifecycleRuleFilter> {
    let gt = f.object_size_greater_than.as_ref().map(|n| i64_of(n, "The minimum object size")).transpose()?;
    let lt = f.object_size_less_than.as_ref().map(|n| i64_of(n, "The maximum object size")).transpose()?;
    let conditions = usize::from(f.prefix.is_some()) + f.tags.len() + usize::from(gt.is_some()) + usize::from(lt.is_some());
    let b = s3::LifecycleRuleFilter::builder();
    Ok(if conditions <= 1 {
        let tag = f.tags.first().map(tag_to_sdk).transpose()?;
        b.set_prefix(f.prefix.clone())
            .set_tag(tag)
            .set_object_size_greater_than(gt)
            .set_object_size_less_than(lt)
            .build()
    } else {
        let tags = if f.tags.is_empty() { None } else { Some(f.tags.iter().map(tag_to_sdk).collect::<AppResult<Vec<_>>>()?) };
        let and = s3::LifecycleRuleAndOperator::builder()
            .set_prefix(f.prefix.clone())
            .set_tags(tags)
            .set_object_size_greater_than(gt)
            .set_object_size_less_than(lt)
            .build();
        b.and(and).build()
    })
}

/// Our rule as the SDK's. Always writes a `Filter` (never the deprecated top-level `Prefix`).
/// Expects a rule that passed [`validate_lifecycle`]; numbers that are not whole are `InvalidInput`.
pub fn rule_to_sdk(r: &LifecycleRule) -> AppResult<s3::LifecycleRule> {
    let transitions = r
        .transitions
        .iter()
        .map(|t| {
            Ok(s3::Transition::builder()
                .set_days(t.days.as_ref().map(|d| i32_of(d, "Transition days")).transpose()?)
                .set_date(t.date.as_deref().map(date_to_sdk).transpose()?)
                .storage_class(class_to_sdk(t.storage_class))
                .build())
        })
        .collect::<AppResult<Vec<_>>>()?;
    let expiration = r
        .expiration
        .as_ref()
        .map(|e| {
            Ok::<_, AppError>(
                s3::LifecycleExpiration::builder()
                    .set_days(e.days.as_ref().map(|d| i32_of(d, "Expiration days")).transpose()?)
                    .set_date(e.date.as_deref().map(date_to_sdk).transpose()?)
                    .set_expired_object_delete_marker(e.expired_object_delete_marker.then_some(true))
                    .build(),
            )
        })
        .transpose()?;
    let nct = r
        .noncurrent_version_transitions
        .iter()
        .map(|t| {
            Ok(s3::NoncurrentVersionTransition::builder()
                .set_noncurrent_days(t.noncurrent_days.as_ref().map(|d| i32_of(d, "Noncurrent days")).transpose()?)
                .set_newer_noncurrent_versions(
                    t.newer_noncurrent_versions.as_ref().map(|d| i32_of(d, "Newer noncurrent versions")).transpose()?,
                )
                .storage_class(class_to_sdk(t.storage_class))
                .build())
        })
        .collect::<AppResult<Vec<_>>>()?;
    let nce = r
        .noncurrent_version_expiration
        .as_ref()
        .map(|e| {
            Ok::<_, AppError>(
                s3::NoncurrentVersionExpiration::builder()
                    .set_noncurrent_days(e.noncurrent_days.as_ref().map(|d| i32_of(d, "Noncurrent days")).transpose()?)
                    .set_newer_noncurrent_versions(
                        e.newer_noncurrent_versions.as_ref().map(|d| i32_of(d, "Newer noncurrent versions")).transpose()?,
                    )
                    .build(),
            )
        })
        .transpose()?;
    let abort = r
        .abort_incomplete_multipart_upload
        .as_ref()
        .map(|a| {
            Ok::<_, AppError>(
                s3::AbortIncompleteMultipartUpload::builder()
                    .set_days_after_initiation(
                        a.days_after_initiation.as_ref().map(|d| i32_of(d, "Days after initiation")).transpose()?,
                    )
                    .build(),
            )
        })
        .transpose()?;
    s3::LifecycleRule::builder()
        .set_id((!r.id.is_empty()).then(|| r.id.clone()))
        .status(match r.status {
            RuleStatus::Enabled => s3::ExpirationStatus::Enabled,
            RuleStatus::Disabled => s3::ExpirationStatus::Disabled,
        })
        .filter(filter_to_sdk(&r.filter)?)
        .set_transitions((!transitions.is_empty()).then_some(transitions))
        .set_expiration(expiration)
        .set_noncurrent_version_transitions((!nct.is_empty()).then_some(nct))
        .set_noncurrent_version_expiration(nce)
        .set_abort_incomplete_multipart_upload(abort)
        .build()
        .map_err(|e| AppError::invalid(format!("Invalid lifecycle rule: {e}")))
}

pub fn config_to_sdk(c: &LifecycleConfiguration) -> AppResult<s3::BucketLifecycleConfiguration> {
    let rules = c.rules.iter().map(rule_to_sdk).collect::<AppResult<Vec<_>>>()?;
    s3::BucketLifecycleConfiguration::builder()
        .set_rules(Some(rules))
        .build()
        .map_err(|e| AppError::invalid(format!("Invalid lifecycle configuration: {e}")))
}

// ---- validation ----------------------------------------------------------------------------

/// When an action happens, once it is valid: days after creation (or after becoming noncurrent),
/// or a date (seconds since the epoch).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum When {
    Days(i64),
    Date(i64),
}

impl When {
    fn text(self) -> String {
        match self {
            When::Days(0) => "on day 0".to_string(),
            When::Days(d) => format!("after {}", days_text(d)),
            When::Date(s) => format!("on {}", ymd(s)),
        }
    }
    /// Days from `self` to `later` when both are the same kind.
    fn gap_to(self, later: When) -> Option<i64> {
        match (self, later) {
            (When::Days(a), When::Days(b)) => Some(b - a),
            (When::Date(a), When::Date(b)) => Some((b - a).div_euclid(DAY_SECS)),
            _ => None,
        }
    }
    fn field(self) -> &'static str {
        match self {
            When::Days(_) => "days",
            When::Date(_) => "date",
        }
    }
    fn plus_days(self, n: i64) -> String {
        match self {
            When::Days(d) => format!("after at least {}", days_text(d + n)),
            When::Date(s) => format!("on {} or later", ymd(s + n * DAY_SECS)),
        }
    }
}

struct Checker<'a> {
    rule: usize,
    /// Midnight UTC today, seconds since the epoch (for the past-date note).
    today: i64,
    out: &'a mut Vec<LifecycleIssue>,
}

impl Checker<'_> {
    fn add(&mut self, field: Option<String>, message: impl Into<String>) {
        self.out.push(LifecycleIssue { rule_index: Some(self.rule), field, message: message.into() });
    }
    fn at(&mut self, field: impl Into<String>, message: impl Into<String>) {
        self.add(Some(field.into()), message);
    }

    /// A whole number in `min..=max`; adds an issue at `field` and returns `None` otherwise.
    fn whole(&mut self, n: &Number, min: i64, max: i64, field: &str, what: &str) -> Option<i64> {
        match int_of(n) {
            Some(i) if (min..=max).contains(&i) => Some(i),
            Some(i) if i > max => {
                self.at(field, format!("{what} must be at most {max} (it is {i})."));
                None
            }
            _ => {
                self.at(field, format!("{what} must be a whole number, {min} or more (it is {n})."));
                None
            }
        }
    }

    /// Exactly one of `days` (at least `min_days`) / `date`; returns when the action happens if valid.
    fn when(
        &mut self,
        days: Option<&Number>,
        date: Option<&str>,
        min_days: i64,
        base: &str,
        what: &str,
        needs: &str,
    ) -> Option<When> {
        match (days, date) {
            (None, None) => {
                self.at(format!("{base}.days"), format!("Choose when {needs}: a number of days or a date."));
                None
            }
            (Some(_), Some(_)) => {
                self.at(format!("{base}.days"), format!("{what} has both days and a date; use only one."));
                None
            }
            (Some(d), None) => {
                self.whole(d, min_days, i64::from(i32::MAX), &format!("{base}.days"), "Days").map(When::Days)
            }
            (None, Some(s)) => match parse_midnight(s) {
                Ok(secs) => {
                    if secs <= self.today {
                        let verb = if base == "expiration" { "deleted" } else { "moved" };
                        self.at(
                            format!("{base}.date"),
                            format!(
                                "{NOTE_PREFIX}this date is today or in the past, so every matching object, and every new one, is {verb} at the next daily run."
                            ),
                        );
                    }
                    Some(When::Date(secs))
                }
                Err(m) => {
                    self.at(format!("{base}.date"), m);
                    None
                }
            },
        }
    }
}

const WATERFALL: &str = "STANDARD_IA → INTELLIGENT_TIERING → ONEZONE_IA → GLACIER_IR → GLACIER → DEEP_ARCHIVE";

/// STANDARD_IA and ONEZONE_IA: at least 30 days after creation, and an archive transition after
/// one of them must be at least 30 days later. (INTELLIGENT_TIERING has neither constraint.)
fn needs_30_days(c: StorageClass) -> bool {
    matches!(c, StorageClass::StandardIa | StorageClass::OnezoneIa)
}

/// Distinct classes, same-tier exclusivity and "only colder over time" for a list of
/// (storage class, when) pairs. `gap` applies the 30-day minimum between a STANDARD_IA /
/// ONEZONE_IA transition and a later archive one. Issues go on the colder item (`base[i].storageClass`, or
/// its time field: `days_field`, or `days`/`date` when `None`); `noun` is "transition" or
/// "noncurrent-version transition".
fn check_order(
    ck: &mut Checker,
    items: &[(StorageClass, Option<When>)],
    base: &str,
    noun: &str,
    gap: bool,
    days_field: Option<&str>,
) {
    for j in 0..items.len() {
        let (cj, wj) = items[j];
        // Each class once.
        if let Some(k) = (0..j).find(|&k| items[k].0 == cj) {
            ck.at(
                format!("{base}[{j}].storageClass"),
                format!(
                    "There is already a {noun} to {} in this rule ({noun} {}). Each storage class can be used once.",
                    cj.as_str(),
                    k + 1
                ),
            );
            continue;
        }
        let Some(wj) = wj else { continue };
        let when_field = format!("{base}[{j}].{}", days_field.unwrap_or(wj.field()));
        // Compare with every class earlier in the waterfall (either list order); each pair is
        // reported once, on the later class.
        for &(ck_class, wk) in items {
            if ck_class.rank() >= cj.rank() {
                continue;
            }
            let Some(wk) = wk else { continue };
            let Some(g) = wk.gap_to(wj) else { continue };
            if g <= 0 {
                ck.at(
                    when_field.clone(),
                    format!(
                        "{} to {} {} comes before (or at the same time as) the {noun} to {} {}: transitions follow \
S3's order {WATERFALL}, so {} must come later.",
                        capitalize(noun),
                        cj.as_str(),
                        wj.text(),
                        ck_class.as_str(),
                        wk.text(),
                        cj.as_str()
                    ),
                );
                break;
            }
            if gap && needs_30_days(ck_class) && cj.is_archive() && g < MIN_DAYS_BETWEEN_TIERS {
                ck.at(
                    when_field.clone(),
                    format!(
                        "{} to {} {} comes before the {MIN_DAYS_BETWEEN_TIERS}-day minimum for the earlier {} {noun} \
({}): it must be {}.",
                        capitalize(noun),
                        cj.as_str(),
                        wj.text(),
                        ck_class.as_str(),
                        wk.text(),
                        wk.plus_days(MIN_DAYS_BETWEEN_TIERS)
                    ),
                );
                break;
            }
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn check_filter(ck: &mut Checker, f: &LifecycleFilter) {
    if let Some(p) = &f.prefix {
        if p.len() > PREFIX_MAX_BYTES {
            ck.at(
                "filter.prefix",
                format!("The prefix is {} bytes long; the limit is {PREFIX_MAX_BYTES} bytes (UTF-8).", p.len()),
            );
        }
    }
    if f.tags.len() > FILTER_MAX_TAGS {
        ck.at(
            "filter.tags",
            format!(
                "A filter can have at most {FILTER_MAX_TAGS} tags (an object never has more, so the rule could never \
match); there are {}.",
                f.tags.len()
            ),
        );
    }
    for (j, t) in f.tags.iter().enumerate() {
        let field = format!("filter.tags[{j}].key");
        if let Err(e) = tags::validate_tags(std::slice::from_ref(t), 1) {
            ck.at(field, e.message);
        } else if f.tags[..j].iter().any(|o| o.key == t.key) {
            ck.at(field, format!("The tag key “{}” is used more than once in this filter.", t.key));
        }
    }
    let gt = f.object_size_greater_than.as_ref().and_then(|n| {
        ck.whole(n, 0, i64::MAX, "filter.objectSizeGreaterThan", "The minimum object size (bytes)")
    });
    let lt = f
        .object_size_less_than
        .as_ref()
        .and_then(|n| ck.whole(n, 1, i64::MAX, "filter.objectSizeLessThan", "The maximum object size (bytes)"));
    if let (Some(gt), Some(lt)) = (gt, lt) {
        if gt >= lt {
            ck.at(
                "filter.objectSizeGreaterThan",
                format!(
                    "“Larger than” ({gt} bytes) must be less than “smaller than” ({lt} bytes), or no object can match."
                ),
            );
        }
    }
}

fn filter_has_tags_or_size(f: &LifecycleFilter) -> bool {
    !f.tags.is_empty() || f.object_size_greater_than.is_some() || f.object_size_less_than.is_some()
}

fn check_rule(ck: &mut Checker, r: &LifecycleRule) {
    // ID
    let n = r.id.chars().count();
    if n == 0 {
        ck.at("id", "Give the rule an ID (a name of up to 255 characters).");
    } else if n > RULE_ID_MAX_CHARS {
        ck.at("id", format!("The rule ID is {n} characters long; the limit is {RULE_ID_MAX_CHARS}."));
    }

    // At least one action.
    let has_action = !r.transitions.is_empty()
        || r.expiration.is_some()
        || !r.noncurrent_version_transitions.is_empty()
        || r.noncurrent_version_expiration.is_some()
        || r.abort_incomplete_multipart_upload.is_some();
    if !has_action {
        ck.add(
            None,
            "This rule does nothing: add at least one action (a transition, an expiration, a noncurrent-version \
action, or aborting incomplete multipart uploads).",
        );
    }

    check_filter(ck, &r.filter);
    let tag_or_size = filter_has_tags_or_size(&r.filter);

    // Transitions.
    let mut current: Vec<(StorageClass, Option<When>)> = Vec::with_capacity(r.transitions.len());
    for (j, t) in r.transitions.iter().enumerate() {
        let base = format!("transitions[{j}]");
        let class = t.storage_class.as_str();
        // Day 0 is allowed for transitions (moves on the day of creation).
        let w = ck.when(
            t.days.as_ref(),
            t.date.as_deref(),
            0,
            &base,
            &format!("The transition to {class}"),
            &format!("objects move to {class}"),
        );
        if let Some(When::Days(d)) = w {
            if needs_30_days(t.storage_class) && d < MIN_DAYS_TO_INFREQUENT_ACCESS {
                ck.at(
                    format!("{base}.days"),
                    format!(
                        "A transition to {class} must be at least {MIN_DAYS_TO_INFREQUENT_ACCESS} days after creation \
(this one is {}).",
                        When::Days(d).text()
                    ),
                );
            }
        }
        current.push((t.storage_class, w));
    }
    check_order(ck, &current, "transitions", "transition", true, None);

    // Expiration.
    let mut exp_when = None;
    if let Some(e) = &r.expiration {
        if e.expired_object_delete_marker {
            if e.days.is_some() || e.date.is_some() {
                ck.at(
                    "expiration.expiredObjectDeleteMarker",
                    "“Delete expired object delete markers” can't be combined with days or a date in the same \
expiration.",
                );
            }
            if tag_or_size {
                ck.at(
                    "expiration.expiredObjectDeleteMarker",
                    "“Delete expired object delete markers” can't be used in a rule whose filter has tags or \
object-size conditions.",
                );
            }
        } else {
            exp_when = ck.when(e.days.as_ref(), e.date.as_deref(), 1, "expiration", "The expiration", "objects expire");
        }
        if let Some(we) = exp_when {
            for &(class, wt) in &current {
                let Some(wt) = wt else { continue };
                if wt.gap_to(we).is_some_and(|g| g <= 0) {
                    ck.at(
                        format!("expiration.{}", we.field()),
                        format!(
                            "Expiration {} must come after every transition; the transition to {} is {}.",
                            we.text(),
                            class.as_str(),
                            wt.text()
                        ),
                    );
                    break;
                }
            }
        }
    }

    // Days and dates can't be mixed in one rule's transitions and expiration.
    let mut whens: Vec<(String, When)> = current
        .iter()
        .enumerate()
        .filter_map(|(j, (_, w))| w.map(|w| (format!("transitions[{j}].{}", w.field()), w)))
        .collect();
    if let Some(w) = exp_when {
        whens.push((format!("expiration.{}", w.field()), w));
    }
    let any_days = whens.iter().any(|(_, w)| matches!(w, When::Days(_)));
    if any_days {
        if let Some((field, _)) = whens.iter().find(|(_, w)| matches!(w, When::Date(_))) {
            ck.at(
                field.clone(),
                "Use days for every transition and the expiration in this rule, or dates for all of them, not a mix.",
            );
        }
    }

    // Noncurrent-version transitions.
    let mut noncurrent: Vec<(StorageClass, Option<When>)> = Vec::with_capacity(r.noncurrent_version_transitions.len());
    for (j, t) in r.noncurrent_version_transitions.iter().enumerate() {
        let base = format!("noncurrentVersionTransitions[{j}]");
        let w = match &t.noncurrent_days {
            None => {
                ck.at(
                    format!("{base}.noncurrentDays"),
                    format!(
                        "Enter how many days after becoming noncurrent versions move to {}.",
                        t.storage_class.as_str()
                    ),
                );
                None
            }
            Some(d) => ck
                .whole(d, 1, i64::from(i32::MAX), &format!("{base}.noncurrentDays"), "Noncurrent days")
                .map(When::Days),
        };
        if let Some(n) = &t.newer_noncurrent_versions {
            ck.whole(
                n,
                NEWER_NONCURRENT_MIN,
                NEWER_NONCURRENT_MAX,
                &format!("{base}.newerNoncurrentVersions"),
                "Versions to keep",
            );
        }
        noncurrent.push((t.storage_class, w));
    }
    check_order(
        ck,
        &noncurrent,
        "noncurrentVersionTransitions",
        "noncurrent-version transition",
        false,
        Some("noncurrentDays"),
    );

    // Noncurrent-version expiration.
    if let Some(e) = &r.noncurrent_version_expiration {
        let days = match &e.noncurrent_days {
            None => {
                ck.at(
                    "noncurrentVersionExpiration.noncurrentDays",
                    "Enter how many days after becoming noncurrent versions are deleted.",
                );
                None
            }
            Some(d) => {
                ck.whole(d, 1, i64::from(i32::MAX), "noncurrentVersionExpiration.noncurrentDays", "Noncurrent days")
            }
        };
        if let Some(n) = &e.newer_noncurrent_versions {
            ck.whole(
                n,
                NEWER_NONCURRENT_MIN,
                NEWER_NONCURRENT_MAX,
                "noncurrentVersionExpiration.newerNoncurrentVersions",
                "Versions to keep",
            );
        }
        if let Some(d) = days {
            if let Some((class, Some(When::Days(t)))) = noncurrent.iter().find(|(_, w)| matches!(w, Some(When::Days(t)) if *t >= d)) {
                ck.at(
                    "noncurrentVersionExpiration.noncurrentDays",
                    format!(
                        "Noncurrent versions are deleted after {} but the noncurrent-version transition to {} is after {}; \
deletion must come after every transition.",
                        days_text(d),
                        class.as_str(),
                        days_text(*t)
                    ),
                );
            }
        }
    }

    // Abort incomplete multipart uploads.
    if let Some(a) = &r.abort_incomplete_multipart_upload {
        let field = "abortIncompleteMultipartUpload.daysAfterInitiation";
        match &a.days_after_initiation {
            None => ck.at(field, "Enter after how many days incomplete multipart uploads are aborted."),
            Some(d) => {
                ck.whole(d, 1, i64::from(i32::MAX), field, "Days after the upload started");
            }
        }
        if tag_or_size {
            ck.at(
                field,
                "Aborting incomplete multipart uploads can't be used in a rule whose filter has tags or object-size \
conditions.",
            );
        }
    }
}

/// Every problem with `config`, placed by rule index and field (`[]`: valid). Pure: no network.
/// An empty configuration is valid (saving it deletes the bucket's lifecycle configuration).
pub fn validate_lifecycle(config: &LifecycleConfiguration) -> Vec<LifecycleIssue> {
    validate_lifecycle_at(config, chrono::Utc::now().timestamp())
}

/// Start of the message of an issue that informs but does not block saving (a date that is today
/// or in the past). `put_lifecycle` ignores these.
pub const NOTE_PREFIX: &str = "Note: ";

/// [`validate_lifecycle`] as of `now` (seconds since the epoch).
pub fn validate_lifecycle_at(config: &LifecycleConfiguration, now: i64) -> Vec<LifecycleIssue> {
    let today = now - now.rem_euclid(DAY_SECS);
    let mut out = Vec::new();
    if config.rules.len() > MAX_RULES {
        out.push(LifecycleIssue {
            rule_index: None,
            field: None,
            message: format!(
                "A lifecycle configuration can have at most {} rules; this one has {}.",
                "1,000",
                config.rules.len()
            ),
        });
    }
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for (i, r) in config.rules.iter().enumerate() {
        check_rule(&mut Checker { rule: i, today, out: &mut out }, r);
        if r.id.is_empty() {
            continue;
        }
        if let Some(first) = seen.get(r.id.as_str()) {
            out.push(LifecycleIssue {
                rule_index: Some(i),
                field: None,
                message: format!(
                    "The rule ID “{}” is already used by rule {}. Rule IDs must be unique.",
                    r.id,
                    first + 1
                ),
            });
        } else {
            seen.insert(&r.id, i);
        }
    }
    out
}

/// `InvalidInput` message listing the issues (at most 10, then a count).
pub fn issues_message(config: &LifecycleConfiguration, issues: &[LifecycleIssue]) -> String {
    const SHOWN: usize = 10;
    let parts: Vec<String> = issues
        .iter()
        .take(SHOWN)
        .map(|i| match i.rule_index {
            Some(r) => {
                let id = config.rules.get(r).map(|x| x.id.as_str()).unwrap_or("");
                format!("{}: {}", capitalize(&rule_label(r, id)), i.message)
            }
            None => i.message.clone(),
        })
        .collect();
    let more = if issues.len() > SHOWN { format!(" (and {} more)", issues.len() - SHOWN) } else { String::new() };
    let n = issues.len();
    format!(
        "The lifecycle configuration was not saved because it has {} {}{more}: {}",
        n,
        if n == 1 { "problem" } else { "problems" },
        parts.join(" ")
    )
}

// ---- semantic comparison -------------------------------------------------------------------

fn canon_num(n: &Number) -> Number {
    int_of(n).map(num).unwrap_or_else(|| n.clone())
}

fn canon_date(s: &str) -> String {
    parse_midnight(s).map(format_secs).unwrap_or_else(|_| s.to_string())
}

/// `r` in a canonical form: an empty prefix is no prefix, filter tags sorted, numbers and dates in
/// one spelling, transitions sorted (S3 keeps rule order, but not meaning in transition order).
pub fn canonical_rule(r: &LifecycleRule) -> LifecycleRule {
    let mut c = r.clone();
    if c.filter.prefix.as_deref() == Some("") {
        c.filter.prefix = None;
    }
    c.filter.tags.sort();
    c.filter.object_size_greater_than = c.filter.object_size_greater_than.as_ref().map(canon_num);
    c.filter.object_size_less_than = c.filter.object_size_less_than.as_ref().map(canon_num);
    for t in &mut c.transitions {
        t.days = t.days.as_ref().map(canon_num);
        t.date = t.date.as_deref().map(canon_date);
    }
    c.transitions.sort_by(|a, b| {
        (a.days.as_ref().and_then(int_of), &a.date, a.storage_class).cmp(&(b.days.as_ref().and_then(int_of), &b.date, b.storage_class))
    });
    if let Some(e) = &mut c.expiration {
        e.days = e.days.as_ref().map(canon_num);
        e.date = e.date.as_deref().map(canon_date);
    }
    for t in &mut c.noncurrent_version_transitions {
        t.noncurrent_days = t.noncurrent_days.as_ref().map(canon_num);
        t.newer_noncurrent_versions = t.newer_noncurrent_versions.as_ref().map(canon_num);
    }
    c.noncurrent_version_transitions.sort_by(|a, b| {
        let ka = (a.noncurrent_days.as_ref().and_then(int_of), a.newer_noncurrent_versions.as_ref().and_then(int_of), a.storage_class);
        let kb = (b.noncurrent_days.as_ref().and_then(int_of), b.newer_noncurrent_versions.as_ref().and_then(int_of), b.storage_class);
        ka.cmp(&kb)
    });
    if let Some(e) = &mut c.noncurrent_version_expiration {
        e.noncurrent_days = e.noncurrent_days.as_ref().map(canon_num);
        e.newer_noncurrent_versions = e.newer_noncurrent_versions.as_ref().map(canon_num);
    }
    if let Some(a) = &mut c.abort_incomplete_multipart_upload {
        a.days_after_initiation = a.days_after_initiation.as_ref().map(canon_num);
    }
    c
}

fn rules_of(c: Option<&LifecycleConfiguration>) -> &[LifecycleRule] {
    c.map(|c| c.rules.as_slice()).unwrap_or(&[])
}

/// True when both hold the same rules in the same order after [`canonical_rule`]. No
/// configuration and an empty one are the same.
pub fn same_configuration(a: Option<&LifecycleConfiguration>, b: Option<&LifecycleConfiguration>) -> bool {
    let (ra, rb) = (rules_of(a), rules_of(b));
    ra.len() == rb.len() && ra.iter().zip(rb).all(|(x, y)| canonical_rule(x) == canonical_rule(y))
}

/// What differs between what was sent and what the server stored, for a message.
pub fn differences(sent: &LifecycleConfiguration, stored: Option<&LifecycleConfiguration>) -> Vec<String> {
    let got = rules_of(stored);
    if got.len() != sent.rules.len() {
        return vec![format!("it stored {} rules instead of {}", got.len(), sent.rules.len())];
    }
    let mut out = Vec::new();
    for (i, (a, b)) in sent.rules.iter().zip(got).enumerate() {
        let (a, b) = (canonical_rule(a), canonical_rule(b));
        let mut fields = Vec::new();
        if a.id != b.id {
            fields.push("id");
        }
        if a.status != b.status {
            fields.push("status");
        }
        if a.filter != b.filter {
            fields.push("filter");
        }
        if a.transitions != b.transitions {
            fields.push("transitions");
        }
        if a.expiration != b.expiration {
            fields.push("expiration");
        }
        if a.noncurrent_version_transitions != b.noncurrent_version_transitions {
            fields.push("noncurrent-version transitions");
        }
        if a.noncurrent_version_expiration != b.noncurrent_version_expiration {
            fields.push("noncurrent-version expiration");
        }
        if a.abort_incomplete_multipart_upload != b.abort_incomplete_multipart_upload {
            fields.push("abort incomplete multipart uploads");
        }
        if !fields.is_empty() {
            out.push(format!("{}: {}", rule_label(i, &a.id), fields.join(", ")));
        }
    }
    out
}

// ---- S3 calls ------------------------------------------------------------------------------

fn feature(e: AppError, what: &str) -> AppError {
    if e.code == ErrorCode::NotSupported {
        AppError::new(ErrorCode::NotSupported, format!("This server does not support {what} ({}).", e.message))
    } else {
        e
    }
}

/// What `GetBucketLifecycleConfiguration` returned, kept raw so a rollback writes back exactly
/// what was there.
struct Stored {
    rules: Vec<s3::LifecycleRule>,
    min_size: Option<s3::TransitionDefaultMinimumObjectSize>,
}

async fn read_raw(client: &Client, bucket: &str) -> AppResult<Stored> {
    match client.get_bucket_lifecycle_configuration().bucket(bucket).send().await {
        Ok(out) => Ok(Stored {
            rules: out.rules.unwrap_or_default(),
            min_size: out.transition_default_minimum_object_size,
        }),
        Err(e) => {
            if e.as_service_error().and_then(|s| s.code()) == Some("NoSuchLifecycleConfiguration") {
                Ok(Stored { rules: Vec::new(), min_size: None })
            } else {
                Err(feature(AppError::from(e), "lifecycle configuration"))
            }
        }
    }
}

/// The bucket's lifecycle configuration, `None` when it has none.
pub async fn get_lifecycle(client: &Client, bucket: &str) -> AppResult<Option<LifecycleConfiguration>> {
    config_from_sdk(&read_raw(client, bucket).await?.rules)
}

/// Writes `rules` (empty: `DeleteBucketLifecycle`), keeping the bucket's
/// `TransitionDefaultMinimumObjectSize` as it was. Errors are the server's, unwrapped.
async fn write_raw(
    client: &Client,
    bucket: &str,
    config: Option<s3::BucketLifecycleConfiguration>,
    min_size: Option<s3::TransitionDefaultMinimumObjectSize>,
) -> AppResult<()> {
    match config {
        None => {
            client
                .delete_bucket_lifecycle()
                .bucket(bucket)
                .send()
                .await
                .map_err(AppError::from)?;
        }
        Some(c) => {
            client
                .put_bucket_lifecycle_configuration()
                .bucket(bucket)
                .lifecycle_configuration(c)
                .set_transition_default_minimum_object_size(min_size)
                .send()
                .await
                .map_err(AppError::from)?;
        }
    }
    Ok(())
}

/// Delays before each read-back after a write (about 20 s in all). Bucket configuration
/// propagates with a lag, so the first reads may still show the configuration from before.
const READ_BACK_DELAYS_MS: [u64; 7] = [0, 500, 1000, 2000, 4000, 8000, 4500];

fn read_back_delays() -> Vec<Duration> {
    READ_BACK_DELAYS_MS.iter().map(|&ms| Duration::from_millis(ms)).collect()
}

/// What repeated reads after a write showed.
#[derive(Debug)]
enum Settled {
    /// The target configuration.
    Target(Option<LifecycleConfiguration>),
    /// Two consecutive reads showed the same configuration that is neither the target nor the
    /// one from before the write.
    Different(Option<LifecycleConfiguration>),
    /// Out of reads without either (still the old one, or something else only once).
    Unconfirmed,
    ReadFailed(AppError),
}

/// Reads until the stored configuration is `target`. A read equal to `before` is propagation lag
/// (keep waiting); a configuration that is neither counts only when two consecutive reads agree.
async fn settle(
    client: &Client,
    bucket: &str,
    target: Option<&LifecycleConfiguration>,
    before: Option<&LifecycleConfiguration>,
    delays: &[Duration],
) -> Settled {
    let mut other: Option<Option<LifecycleConfiguration>> = None;
    for d in delays {
        if !d.is_zero() {
            tokio::time::sleep(*d).await;
        }
        let now = match get_lifecycle(client, bucket).await {
            Ok(now) => now,
            Err(e) => return Settled::ReadFailed(e),
        };
        if same_configuration(now.as_ref(), target) {
            return Settled::Target(now);
        }
        if same_configuration(now.as_ref(), before) {
            other = None; // lag
            continue;
        }
        match &other {
            Some(prev) if same_configuration(prev.as_ref(), now.as_ref()) => return Settled::Different(now),
            _ => other = Some(now),
        }
    }
    Settled::Unconfirmed
}

/// Rule ids in order: a stored configuration with the same ids as what was sent is ours with
/// parts missing; one with other ids was written by someone else.
fn same_rule_ids(a: &LifecycleConfiguration, b: Option<&LifecycleConfiguration>) -> bool {
    let rb = rules_of(b);
    a.rules.len() == rb.len() && a.rules.iter().zip(rb).all(|(x, y)| x.id == y.id)
}

pub const CHANGED_AFTER_SAVE: &str = "The lifecycle configuration was saved, but the server now returns a different \
one (someone else may have changed it right afterwards, or the server did not keep all of it). Nothing was put back. \
Reload to see the current rules.";

/// Replaces the bucket's lifecycle configuration with `config` (no rules: deletes it) and returns
/// what is stored afterwards.
///
/// 1. `validate_lifecycle`; any issue that is not a "Note: " (see [`NOTE_PREFIX`]): `InvalidInput`
///    listing them, nothing written.
/// 2. Re-read the stored configuration; if it is not [`same_configuration`] as `expected` (what
///    the UI loaded, `None` for none): `Conflict`, nothing written.
/// 3. If `config` is already what is stored, nothing is written.
/// 4. Write (a refused write is reported as such, unless a read shows `config` stored after all).
/// 5. Read back until it shows `config`, treating reads of the pre-write configuration as
///    propagation lag (about 20 s). Only when two consecutive reads show our rules with parts
///    missing (a server that accepted and dropped what it does not implement) is the previous
///    configuration put back, failing with `NotSupported` naming what was not kept. Rules with
///    other ids: `Conflict`, nothing put back. A read-back that fails or never confirms:
///    "Saved, but reading back failed: …".
///
/// S3 has no conditional write for lifecycle: a change made by someone else between step 2 and
/// the write is not detected.
pub async fn put_lifecycle(
    client: &Client,
    bucket: &str,
    config: &LifecycleConfiguration,
    expected: Option<&LifecycleConfiguration>,
) -> AppResult<Option<LifecycleConfiguration>> {
    put_lifecycle_with(client, bucket, config, expected, &read_back_delays()).await
}

async fn put_lifecycle_with(
    client: &Client,
    bucket: &str,
    config: &LifecycleConfiguration,
    expected: Option<&LifecycleConfiguration>,
    delays: &[Duration],
) -> AppResult<Option<LifecycleConfiguration>> {
    let issues: Vec<LifecycleIssue> =
        validate_lifecycle(config).into_iter().filter(|i| !i.message.starts_with(NOTE_PREFIX)).collect();
    if !issues.is_empty() {
        return Err(AppError::invalid(issues_message(config, &issues)));
    }
    let sdk = if config.rules.is_empty() { None } else { Some(config_to_sdk(config)?) };

    let before = read_raw(client, bucket).await?;
    // Fails (refusing to write) when the stored configuration uses something we can't represent.
    let current = config_from_sdk(&before.rules)?;
    if !same_configuration(current.as_ref(), expected) {
        return Err(AppError::new(ErrorCode::Conflict, CONFLICT));
    }
    if same_configuration(current.as_ref(), Some(config)) {
        return Ok(current);
    }

    if let Err(e) = write_raw(client, bucket, sdk, before.min_size.clone()).await {
        // A refused write normally changes nothing; check rather than assume.
        let tail = match get_lifecycle(client, bucket).await {
            Ok(now) if same_configuration(now.as_ref(), Some(config)) => return Ok(now), // stored after all
            Ok(now) if same_configuration(now.as_ref(), current.as_ref()) => "Nothing was changed.",
            _ => "Reload to see what is stored now.",
        };
        let message = if e.code == ErrorCode::NotSupported {
            format!(
                "The server refused this lifecycle configuration because it does not implement something in it ({}). {tail}",
                e.message
            )
        } else {
            format!("The server refused the lifecycle configuration ({}). {tail}", e.message)
        };
        return Err(AppError::new(e.code, message));
    }

    let stored = match settle(client, bucket, Some(config), current.as_ref(), delays).await {
        Settled::Target(now) => return Ok(now),
        Settled::ReadFailed(e) => return Err(AppError::saved_but_unread(e)),
        Settled::Unconfirmed => {
            return Err(AppError::saved_but_unread(AppError::new(
                ErrorCode::Unknown,
                "after about 20 seconds the server still does not return the new configuration (changes can take a \
while to apply)",
            )))
        }
        Settled::Different(now) => now,
    };
    if !same_rule_ids(config, stored.as_ref()) {
        return Err(AppError::new(ErrorCode::Conflict, CHANGED_AFTER_SAVE));
    }

    // The server did not keep what it accepted: put the previous configuration back.
    let what = differences(config, stored.as_ref()).join("; ");
    let previous = if before.rules.is_empty() {
        None
    } else {
        s3::BucketLifecycleConfiguration::builder().set_rules(Some(before.rules.clone())).build().ok()
    };
    let restore = if !before.rules.is_empty() && previous.is_none() {
        Err(AppError::invalid("the previous configuration could not be rebuilt"))
    } else {
        write_raw(client, bucket, previous, before.min_size.clone()).await
    };
    let restored = match restore {
        Ok(()) => match settle(client, bucket, current.as_ref(), stored.as_ref(), delays).await {
            Settled::Target(_) => Ok(()),
            Settled::ReadFailed(e) => Err(format!("reading it back failed: {}", e.message)),
            Settled::Different(_) | Settled::Unconfirmed => {
                Err("the configuration read back afterwards is different".to_string())
            }
        },
        Err(e) => Err(e.message),
    };
    let tail = match restored {
        Ok(()) => "The previous configuration was put back, so nothing changed.".to_string(),
        Err(e) => format!("Putting the previous configuration back failed ({e}). Reload to see what is stored now."),
    };
    Err(AppError::new(
        ErrorCode::NotSupported,
        format!(
            "The server accepted the lifecycle configuration but did not store all of it ({what}); it probably does \
not support those features. {tail}"
        ),
    ))
}

/// `Enabled` / `Suspended`, or `Off` when versioning was never enabled (no `Status`).
pub async fn get_bucket_versioning(client: &Client, bucket: &str) -> AppResult<BucketVersioning> {
    let out = client
        .get_bucket_versioning()
        .bucket(bucket)
        .send()
        .await
        .map_err(|e| feature(e.into(), "bucket versioning"))?;
    versioning_from_sdk(out.status())
}

pub fn versioning_from_sdk(s: Option<&s3::BucketVersioningStatus>) -> AppResult<BucketVersioning> {
    Ok(match s {
        None => BucketVersioning::Off,
        Some(s3::BucketVersioningStatus::Enabled) => BucketVersioning::Enabled,
        Some(s3::BucketVersioningStatus::Suspended) => BucketVersioning::Suspended,
        Some(other) => {
            return Err(AppError::new(
                ErrorCode::Unknown,
                format!("The bucket's versioning status “{}” is not one this version understands.", other.as_str()),
            ))
        }
    })
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
