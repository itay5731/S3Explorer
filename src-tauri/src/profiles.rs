//! Minimal parser for `~/.aws/config` and `~/.aws/credentials`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::models::ProfileInfo;

type Sections = BTreeMap<String, BTreeMap<String, String>>;

/// Parses INI text into section -> (key -> value). Keys are lowercased.
/// Indented lines (sub-properties such as `s3 =\n  endpoint_url = ...`) are ignored.
pub fn parse_ini(text: &str) -> Sections {
    let mut out: Sections = BTreeMap::new();
    let mut current: Option<String> = None;
    for raw in text.lines() {
        if raw.starts_with(' ') || raw.starts_with('\t') {
            continue;
        }
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            let name = rest.split(']').next().unwrap_or("").trim().to_string();
            out.entry(name.clone()).or_default();
            current = Some(name);
            continue;
        }
        let (Some(sec), Some((k, v))) = (current.as_ref(), line.split_once('=')) else {
            continue;
        };
        out.entry(sec.clone())
            .or_default()
            .insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
    out
}

/// Builds the merged profile list from the contents of the config and credentials files.
pub fn merge_profiles(config_text: &str, credentials_text: &str) -> Vec<ProfileInfo> {
    let mut merged: BTreeMap<String, ProfileInfo> = BTreeMap::new();

    for (section, kv) in parse_ini(config_text) {
        // In the config file, profiles are "[default]" or "[profile name]".
        // Other sections ("[sso-session x]", "[services y]") are not profiles.
        let name = if section == "default" {
            "default".to_string()
        } else if let Some(n) = section.strip_prefix("profile ") {
            n.trim().to_string()
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let creds = kv.contains_key("aws_access_key_id")
            || kv.contains_key("sso_session")
            || kv.contains_key("sso_start_url")
            || kv.contains_key("sso_account_id")
            || kv.contains_key("credential_process")
            || kv.contains_key("role_arn")
            || kv.contains_key("web_identity_token_file");
        let entry = merged.entry(name.clone()).or_insert(ProfileInfo { name, region: None, has_credentials: false });
        if let Some(r) = kv.get("region").filter(|r| !r.is_empty()) {
            entry.region = Some(r.clone());
        }
        entry.has_credentials |= creds;
    }

    for (section, kv) in parse_ini(credentials_text) {
        // The credentials file uses bare names; tolerate a "profile " prefix too.
        let name = section.strip_prefix("profile ").unwrap_or(&section).trim().to_string();
        if name.is_empty() {
            continue;
        }
        let creds = kv.contains_key("aws_access_key_id") || kv.contains_key("credential_process");
        let entry = merged.entry(name.clone()).or_insert(ProfileInfo { name, region: None, has_credentials: false });
        if entry.region.is_none() {
            entry.region = kv.get("region").filter(|r| !r.is_empty()).cloned();
        }
        entry.has_credentials |= creds;
    }

    let mut list: Vec<ProfileInfo> = merged.into_values().collect();
    list.sort_by(|a, b| (a.name != "default", &a.name).cmp(&(b.name != "default", &b.name)));
    list
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn file_path(env: &str, default_name: &str) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(env).filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    home_dir().map(|h| h.join(".aws").join(default_name))
}

/// Reads and merges the user's AWS profiles. Missing files are treated as empty.
pub async fn load_profiles() -> Vec<ProfileInfo> {
    async fn read(path: Option<PathBuf>) -> String {
        match path {
            Some(p) => tokio::fs::read_to_string(p).await.unwrap_or_default(),
            None => String::new(),
        }
    }
    let config = read(file_path("AWS_CONFIG_FILE", "config")).await;
    let creds = read(file_path("AWS_SHARED_CREDENTIALS_FILE", "credentials")).await;
    merge_profiles(&config, &creds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges() {
        let config = "[default]\nregion = eu-west-1\n\n[profile dev]\nsso_session = x\nregion=us-east-2\n[sso-session x]\nsso_region = us-east-1\n[profile nocreds]\nregion = ap-south-1\ns3 =\n  endpoint_url = http://x\n";
        let creds = "[default]\naws_access_key_id = A\naws_secret_access_key = B\n[other]\naws_access_key_id=C\n";
        let p = merge_profiles(config, creds);
        let names: Vec<_> = p.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["default", "dev", "nocreds", "other"]);
        assert_eq!(p[0].region.as_deref(), Some("eu-west-1"));
        assert!(p[0].has_credentials);
        assert!(p[1].has_credentials);
        assert!(!p[2].has_credentials);
        assert_eq!(p[3].region, None);
        assert!(p[3].has_credentials);
    }
}
