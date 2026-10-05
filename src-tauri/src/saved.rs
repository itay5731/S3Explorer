//! Saved connections: metadata in `connections.json` (app config dir), secrets only in the OS
//! keychain (see [`crate::keychain`]).
//!
//! Free of Tauri types so it is unit-testable with a temp dir and [`MemoryKeychain`]
//! (`crate::keychain::MemoryKeychain`).
//!
//! Invariants:
//! - `connections.json` never contains secret material (the stored record has no secret field).
//! - No half-saved state: a failed keychain write stores nothing; a failed metadata write after a
//!   keychain write restores the previous keychain state.
//! - Loading never fails: a missing or corrupt file is an empty list; unreadable entries are skipped.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::keychain::{Secret, SecretStore};
use crate::models::{
    now_iso, ConnectionConfig, ConnectionInfo, SaveConnectionInput, SavedConnection, SavedConnectionKind,
    SAVED_CONNECTION_NAME_MAX,
};
use crate::settings::write_json_atomic;
use crate::state::{AppState, Connection};

pub const CONNECTIONS_FILE: &str = "connections.json";
const FILE_VERSION: u32 = 1;

/// User-facing messages (the UI shows `InvalidInput` from `save_connection` under the name field
/// verbatim, and treats a `connect_saved` `InvalidInput` mentioning "secret" as "secret missing").
pub mod msg {
    pub const NAME_REQUIRED: &str = "Enter a name for this connection.";
    pub const SESSION_TOKEN: &str = "Temporary credentials (with a session token) can't be saved.";
    pub const UNKNOWN_ID: &str = "That saved connection no longer exists.";
    pub const KIND_CHANGE: &str =
        "A saved connection's type can't be changed. Save it as a new connection instead.";
    pub const PROFILE_REQUIRED: &str = "Choose an AWS profile.";
    pub const ACCESS_KEY_REQUIRED: &str = "Enter the access key ID.";
    pub const SECRET_REQUIRED: &str = "Enter the secret access key.";
    pub const MISSING_SECRET: &str = "The secret for this saved connection is missing. Enter it again.";

    pub fn name_too_long(max: usize) -> String {
        format!("The name can be at most {max} characters.")
    }
    pub fn duplicate(name: &str) -> String {
        format!("A saved connection named “{name}” already exists.")
    }
}

/// One entry of `connections.json`. Deliberately has no secret field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredConnection {
    id: String,
    name: String,
    kind: SavedConnectionKind,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    access_key_id: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default = "default_true")]
    force_path_style: bool,
    #[serde(default)]
    last_used_at: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOut<'a> {
    version: u32,
    connections: &'a [StoredConnection],
}

impl StoredConnection {
    fn to_public(&self, has_secret: bool) -> SavedConnection {
        SavedConnection {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
            profile: self.profile.clone(),
            access_key_id: self.access_key_id.clone(),
            region: self.region.clone(),
            endpoint: self.endpoint.clone(),
            force_path_style: self.force_path_style,
            has_secret: self.kind == SavedConnectionKind::Static && has_secret,
            last_used_at: self.last_used_at.clone(),
        }
    }
}

/// Reads `connections.json`. Never fails: missing/corrupt → empty; bad entries and duplicate ids
/// are skipped.
fn load_file(path: &Path) -> Vec<StoredConnection> {
    let Some(v) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else {
        return Vec::new();
    };
    let Some(list) = v.get("connections").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<StoredConnection> = Vec::new();
    for item in list {
        let Ok(c) = serde_json::from_value::<StoredConnection>(item.clone()) else { continue };
        let name = c.name.trim();
        if c.id.trim().is_empty() || name.is_empty() || out.iter().any(|o| o.id == c.id) {
            continue;
        }
        out.push(c);
    }
    out
}

fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// A validated `save_connection` input. `secret: None` = keep the stored secret (update only).
struct Validated {
    record: StoredConnection,
    secret: Option<Secret>,
    is_update: bool,
}

/// Validates `input` against the current list (pure; no IO).
fn validate(input: SaveConnectionInput, existing: &[StoredConnection]) -> AppResult<Validated> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::invalid(msg::NAME_REQUIRED));
    }
    if name.chars().count() > SAVED_CONNECTION_NAME_MAX {
        return Err(AppError::invalid(msg::name_too_long(SAVED_CONNECTION_NAME_MAX)));
    }
    let id = non_empty(input.id.as_deref());
    let current = match &id {
        Some(id) => Some(existing.iter().find(|c| &c.id == id).ok_or_else(|| AppError::invalid(msg::UNKNOWN_ID))?),
        None => None,
    };
    let lower = name.to_lowercase();
    if existing.iter().any(|c| Some(&c.id) != id.as_ref() && c.name.trim().to_lowercase() == lower) {
        return Err(AppError::invalid(msg::duplicate(&name)));
    }

    let (record, secret) = match input.config {
        ConnectionConfig::Profile { profile, region, endpoint } => {
            let profile = non_empty(Some(&profile)).ok_or_else(|| AppError::invalid(msg::PROFILE_REQUIRED))?;
            let record = StoredConnection {
                id: String::new(),
                name,
                kind: SavedConnectionKind::Profile,
                profile: Some(profile),
                access_key_id: None,
                region: non_empty(region.as_deref()),
                endpoint: non_empty(endpoint.as_deref()),
                // Profile connections always use path-style with a custom endpoint (see `Connection::open`).
                force_path_style: true,
                last_used_at: None,
            };
            (record, None)
        }
        ConnectionConfig::Static {
            access_key_id,
            secret_access_key,
            session_token,
            region,
            endpoint,
            force_path_style,
        } => {
            if non_empty(session_token.as_deref()).is_some() {
                return Err(AppError::invalid(msg::SESSION_TOKEN));
            }
            let access_key_id =
                non_empty(Some(&access_key_id)).ok_or_else(|| AppError::invalid(msg::ACCESS_KEY_REQUIRED))?;
            let secret = non_empty(Some(&secret_access_key)).map(Secret::new);
            if secret.is_none() && current.is_none() {
                return Err(AppError::invalid(msg::SECRET_REQUIRED));
            }
            let record = StoredConnection {
                id: String::new(),
                name,
                kind: SavedConnectionKind::Static,
                profile: None,
                access_key_id: Some(access_key_id),
                region: non_empty(Some(&region)),
                endpoint: non_empty(endpoint.as_deref()),
                force_path_style: force_path_style.unwrap_or(true),
                last_used_at: None,
            };
            (record, secret)
        }
    };

    let mut record = record;
    match current {
        Some(cur) => {
            if cur.kind != record.kind {
                return Err(AppError::invalid(msg::KIND_CHANGE));
            }
            record.id = cur.id.clone();
            record.last_used_at = cur.last_used_at.clone();
        }
        None => record.id = uuid::Uuid::new_v4().to_string(),
    }
    Ok(Validated { record, secret, is_update: current.is_some() })
}

/// Sort for `list_saved_connections`: `lastUsedAt` desc (never used last), then name.
fn sort_public(list: &mut [SavedConnection]) {
    list.sort_by(|a, b| {
        let by_time = match (&a.last_used_at, &b.last_used_at) {
            (Some(x), Some(y)) => y.cmp(x),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        by_time.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.id.cmp(&b.id))
    });
}

/// Saved connections plus where they persist. `path: None` keeps them in memory only.
pub struct ConnectionStore {
    path: Option<PathBuf>,
    keychain: Arc<dyn SecretStore>,
    /// Held across each whole operation (validate, keychain, file) so they never interleave.
    items: tokio::sync::Mutex<Vec<StoredConnection>>,
}

impl ConnectionStore {
    /// Loads from `path` (empty if absent/invalid) and persists future changes there.
    pub fn load(path: PathBuf, keychain: Arc<dyn SecretStore>) -> Self {
        let items = load_file(&path);
        Self { path: Some(path), keychain, items: tokio::sync::Mutex::new(items) }
    }

    /// In-memory store (no persistence), e.g. when the config dir cannot be resolved.
    pub fn in_memory(keychain: Arc<dyn SecretStore>) -> Self {
        Self { path: None, keychain, items: tokio::sync::Mutex::new(Vec::new()) }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Runs a blocking keychain call off the async runtime.
    async fn kc<T, F>(&self, f: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&dyn SecretStore) -> AppResult<T> + Send + 'static,
    {
        let k = self.keychain.clone();
        tokio::task::spawn_blocking(move || f(k.as_ref())).await?
    }

    async fn write(&self, items: Vec<StoredConnection>) -> AppResult<Vec<StoredConnection>> {
        let Some(path) = self.path.clone() else { return Ok(items) };
        tokio::task::spawn_blocking(move || {
            write_json_atomic(&path, &FileOut { version: FILE_VERSION, connections: &items }, "saved connections")
                .map(|()| items)
        })
        .await?
    }

    /// Whether a secret exists for each id. A keychain error counts as "no secret" (the connect
    /// attempt then reports the keychain error itself).
    async fn secrets_present(&self, ids: Vec<String>) -> Vec<bool> {
        let n = ids.len();
        self.kc(move |k| Ok(ids.iter().map(|id| matches!(k.get(id), Ok(Some(_)))).collect()))
            .await
            .unwrap_or_else(|_| vec![false; n])
    }

    pub async fn list(&self) -> AppResult<Vec<SavedConnection>> {
        let items = self.items.lock().await.clone();
        let static_ids: Vec<String> =
            items.iter().filter(|c| c.kind == SavedConnectionKind::Static).map(|c| c.id.clone()).collect();
        let present = self.secrets_present(static_ids.clone()).await;
        let mut out: Vec<SavedConnection> = items
            .iter()
            .map(|c| {
                let has = static_ids.iter().position(|id| id == &c.id).is_some_and(|i| present[i]);
                c.to_public(has)
            })
            .collect();
        sort_public(&mut out);
        Ok(out)
    }

    /// Creates or updates a saved connection (see module docs for the all-or-nothing rules).
    pub async fn save(&self, input: SaveConnectionInput) -> AppResult<SavedConnection> {
        let mut items = self.items.lock().await;
        let Validated { record, secret, is_update } = validate(input, &items)?;
        let id = record.id.clone();

        // Keychain first. `previous` remembers what to restore if the metadata write fails.
        let mut previous: Option<Option<Secret>> = None;
        if let Some(secret) = secret {
            let (kid, is_upd) = (id.clone(), is_update);
            previous = Some(
                self.kc(move |k| {
                    let prev = if is_upd { k.get(&kid)? } else { None };
                    k.set(&kid, &secret)?;
                    Ok(prev)
                })
                .await?,
            );
        }

        let mut next = items.clone();
        match next.iter_mut().find(|c| c.id == id) {
            Some(slot) => *slot = record.clone(),
            None => next.push(record.clone()),
        }
        match self.write(next).await {
            Ok(next) => *items = next,
            Err(e) => {
                if let Some(prev) = previous {
                    let kid = id.clone();
                    // Best effort: the original error is what the user needs to see.
                    let _ = self
                        .kc(move |k| match prev {
                            Some(p) => k.set(&kid, &p),
                            None => k.delete(&kid),
                        })
                        .await;
                }
                return Err(e);
            }
        }
        drop(items);

        let has_secret = match record.kind {
            SavedConnectionKind::Profile => false,
            SavedConnectionKind::Static => self.secrets_present(vec![id]).await.first().copied().unwrap_or(false),
        };
        Ok(record.to_public(has_secret))
    }

    /// Removes the metadata and the keychain entry. Unknown id is a no-op. If the metadata write
    /// fails, the secret is put back.
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let mut items = self.items.lock().await;
        let Some(rec) = items.iter().find(|c| c.id == id).cloned() else { return Ok(()) };

        let mut previous: Option<Secret> = None;
        if rec.kind == SavedConnectionKind::Static {
            let kid = rec.id.clone();
            previous = self
                .kc(move |k| {
                    let prev = k.get(&kid)?;
                    k.delete(&kid)?;
                    Ok(prev)
                })
                .await?;
        }

        let next: Vec<StoredConnection> = items.iter().filter(|c| c.id != id).cloned().collect();
        match self.write(next).await {
            Ok(next) => {
                *items = next;
                Ok(())
            }
            Err(e) => {
                if let Some(p) = previous {
                    let kid = rec.id.clone();
                    let _ = self.kc(move |k| k.set(&kid, &p)).await;
                }
                Err(e)
            }
        }
    }

    /// The saved name and a ready-to-use [`ConnectionConfig`] (with the secret from the keychain).
    pub async fn resolve(&self, id: &str) -> AppResult<(String, ConnectionConfig)> {
        let rec = self
            .items
            .lock()
            .await
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| AppError::invalid(msg::UNKNOWN_ID))?;
        let config = match rec.kind {
            SavedConnectionKind::Profile => ConnectionConfig::Profile {
                profile: rec.profile.clone().unwrap_or_default(),
                region: rec.region.clone(),
                endpoint: rec.endpoint.clone(),
            },
            SavedConnectionKind::Static => {
                let kid = rec.id.clone();
                let secret =
                    self.kc(move |k| k.get(&kid)).await?.ok_or_else(|| AppError::invalid(msg::MISSING_SECRET))?;
                ConnectionConfig::Static {
                    access_key_id: rec.access_key_id.clone().unwrap_or_default(),
                    secret_access_key: secret.expose().to_string(),
                    session_token: None,
                    region: rec.region.clone().unwrap_or_default(),
                    endpoint: rec.endpoint.clone(),
                    force_path_style: Some(rec.force_path_style),
                }
            }
        };
        Ok((rec.name, config))
    }

    /// Records a successful connect. A failed write keeps the in-memory value (the next successful
    /// write persists it); the connection itself already succeeded.
    pub async fn mark_used(&self, id: &str) {
        let mut items = self.items.lock().await;
        let mut next = items.clone();
        let Some(slot) = next.iter_mut().find(|c| c.id == id) else { return };
        slot.last_used_at = Some(now_iso());
        match self.write(next.clone()).await {
            Ok(n) => *items = n,
            Err(_) => *items = next,
        }
    }
}

/// `connect_saved`: loads the secret, connects through the same path as `connect`
/// ([`Connection::open`]), labels the connection with the saved name, and updates `lastUsedAt`
/// only when the connection succeeded.
pub async fn connect_saved(store: &ConnectionStore, state: &AppState, id: &str) -> AppResult<ConnectionInfo> {
    let (name, config) = store.resolve(id).await?;
    let mut conn = Connection::open(config).await?;
    conn.info.label = name;
    let info = conn.info.clone();
    state.set_connection(Some(Arc::new(conn))).await;
    store.mark_used(id).await;
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::keychain::{FailOn, MemoryKeychain};

    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("s3explorer-saved-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    fn store(dir: &Path) -> (ConnectionStore, Arc<MemoryKeychain>) {
        let k = Arc::new(MemoryKeychain::new());
        (ConnectionStore::load(dir.join(CONNECTIONS_FILE), k.clone()), k)
    }

    fn static_input(id: Option<&str>, name: &str, secret: &str) -> SaveConnectionInput {
        SaveConnectionInput {
            id: id.map(str::to_string),
            name: name.to_string(),
            config: ConnectionConfig::Static {
                access_key_id: " AKIAEXAMPLE ".into(),
                secret_access_key: secret.into(),
                session_token: None,
                region: "eu-west-1".into(),
                endpoint: Some(" http://127.0.0.1:8333 ".into()),
                force_path_style: Some(false),
            },
        }
    }

    fn profile_input(id: Option<&str>, name: &str) -> SaveConnectionInput {
        SaveConnectionInput {
            id: id.map(str::to_string),
            name: name.to_string(),
            config: ConnectionConfig::Profile { profile: "dev".into(), region: Some("".into()), endpoint: None },
        }
    }

    fn invalid(r: AppResult<SavedConnection>) -> String {
        let e = r.expect_err("should be rejected");
        assert_eq!(e.code, ErrorCode::InvalidInput, "{}", e.message);
        e.message
    }

    #[tokio::test]
    async fn create_static_stores_secret_only_in_keychain() {
        let dir = temp_dir("create");
        let (s, k) = store(&dir);
        let c = s.save(static_input(None, "  Prod  ", SECRET)).await.expect("save");
        assert!(uuid::Uuid::parse_str(&c.id).is_ok(), "uuid id: {}", c.id);
        assert_eq!(c.name, "Prod");
        assert_eq!(c.kind, SavedConnectionKind::Static);
        assert_eq!(c.access_key_id.as_deref(), Some("AKIAEXAMPLE"));
        assert_eq!(c.region.as_deref(), Some("eu-west-1"));
        assert_eq!(c.endpoint.as_deref(), Some("http://127.0.0.1:8333"));
        assert!(!c.force_path_style);
        assert!(c.has_secret);
        assert_eq!(c.last_used_at, None);
        assert_eq!(k.peek(&c.id).map(|s| s.expose().to_string()), Some(SECRET.to_string()));

        // The secret is nowhere in the file, the returned value or its Debug output.
        let text = std::fs::read_to_string(dir.join(CONNECTIONS_FILE)).expect("file");
        assert!(!text.contains(SECRET) && !text.contains("wJalr"), "{text}");
        assert!(text.contains("AKIAEXAMPLE"));
        assert!(!serde_json::to_string(&c).expect("ser").contains(SECRET));
        assert!(!format!("{c:?}").contains(SECRET));
        assert!(!format!("{:?}", static_input(None, "x", SECRET)).contains(SECRET), "input Debug is redacted");

        // Reload from disk: same metadata, hasSecret from the keychain.
        let s2 = ConnectionStore::load(dir.join(CONNECTIONS_FILE), k.clone());
        assert_eq!(s2.list().await.expect("list"), vec![c]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serialized_store_never_contains_secret() {
        // Serialize exactly what `write` writes, from a record built out of an input with a secret.
        let v = validate(static_input(None, "A", SECRET), &[]).expect("valid");
        assert!(v.secret.is_some());
        let json = serde_json::to_string_pretty(&FileOut { version: FILE_VERSION, connections: &[v.record] })
            .expect("ser");
        assert!(!json.contains(SECRET), "{json}");
        assert!(!json.to_lowercase().contains("secret"), "no secret-like field at all: {json}");
    }

    #[tokio::test]
    async fn name_rules() {
        let dir = temp_dir("names");
        let (s, _k) = store(&dir);
        assert_eq!(invalid(s.save(profile_input(None, "   ")).await), msg::NAME_REQUIRED);
        let long: String = "é".repeat(SAVED_CONNECTION_NAME_MAX + 1);
        assert_eq!(invalid(s.save(profile_input(None, &long)).await), msg::name_too_long(64));
        // Exactly 64 characters (multi-byte) after trimming is fine.
        let max: String = "é".repeat(SAVED_CONNECTION_NAME_MAX);
        s.save(profile_input(None, &format!("  {max} "))).await.expect("64 chars ok");

        let a = s.save(profile_input(None, "Work")).await.expect("save");
        let m = invalid(s.save(static_input(None, " WORK ", SECRET)).await);
        assert_eq!(m, "A saved connection named “WORK” already exists.");
        // Renaming a connection to its own name in another case is fine.
        let renamed = s.save(profile_input(Some(&a.id), "work")).await.expect("rename self");
        assert_eq!(renamed.name, "work");
        assert_eq!(renamed.id, a.id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn input_rules() {
        let dir = temp_dir("input");
        let (s, k) = store(&dir);
        let mut with_token = static_input(None, "T", SECRET);
        if let ConnectionConfig::Static { session_token, .. } = &mut with_token.config {
            *session_token = Some("FQoGZXIvYXdz".into());
        }
        assert_eq!(invalid(s.save(with_token).await), msg::SESSION_TOKEN);
        assert_eq!(invalid(s.save(static_input(None, "T", "  ")).await), msg::SECRET_REQUIRED);
        assert_eq!(invalid(s.save(static_input(Some("nope"), "T", SECRET)).await), msg::UNKNOWN_ID);
        let mut no_key = static_input(None, "T", SECRET);
        if let ConnectionConfig::Static { access_key_id, .. } = &mut no_key.config {
            *access_key_id = " ".into();
        }
        assert_eq!(invalid(s.save(no_key).await), msg::ACCESS_KEY_REQUIRED);
        let mut no_profile = profile_input(None, "P");
        if let ConnectionConfig::Profile { profile, .. } = &mut no_profile.config {
            *profile = "".into();
        }
        assert_eq!(invalid(s.save(no_profile).await), msg::PROFILE_REQUIRED);
        assert!(k.is_empty(), "nothing reached the keychain");
        assert!(s.list().await.expect("list").is_empty());
        assert!(!dir.join(CONNECTIONS_FILE).exists(), "nothing written");

        // kind cannot change on update.
        let p = s.save(profile_input(None, "P")).await.expect("profile");
        assert_eq!(invalid(s.save(static_input(Some(&p.id), "P", SECRET)).await), msg::KIND_CHANGE);
        let st = s.save(static_input(None, "S", SECRET)).await.expect("static");
        assert_eq!(invalid(s.save(profile_input(Some(&st.id), "S")).await), msg::KIND_CHANGE);
        assert_eq!(k.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn update_keeps_or_replaces_secret() {
        let dir = temp_dir("update");
        let (s, k) = store(&dir);
        let c = s.save(static_input(None, "A", SECRET)).await.expect("create");
        // Empty secret: keep.
        let u = s.save(static_input(Some(&c.id), "A2", "")).await.expect("update keep");
        assert_eq!(u.id, c.id);
        assert_eq!(u.name, "A2");
        assert!(u.has_secret);
        assert_eq!(k.peek(&c.id).map(|s| s.expose().to_string()), Some(SECRET.into()));
        // New secret: replace.
        let u = s.save(static_input(Some(&c.id), "A2", " new-secret ")).await.expect("update replace");
        assert!(u.has_secret);
        assert_eq!(k.peek(&c.id).map(|s| s.expose().to_string()), Some("new-secret".into()));
        // Update keeps lastUsedAt.
        s.mark_used(&c.id).await;
        let used = s.list().await.expect("list")[0].last_used_at.clone();
        assert!(used.is_some());
        let u = s.save(static_input(Some(&c.id), "A3", "")).await.expect("update");
        assert_eq!(u.last_used_at, used);
        // Update with keep when the secret is gone: allowed, hasSecret false.
        k.remove_externally(&c.id);
        let u = s.save(static_input(Some(&c.id), "A4", "")).await.expect("update");
        assert!(!u.has_secret);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn keychain_failure_stores_nothing() {
        let dir = temp_dir("kcfail");
        let (s, k) = store(&dir);
        k.fail_on(FailOn { set: true, ..Default::default() });
        let e = s.save(static_input(None, "A", SECRET)).await.expect_err("keychain");
        assert_eq!(e.code, ErrorCode::Keychain);
        assert!(!e.message.contains(SECRET));
        assert!(s.list().await.expect("list").is_empty());
        assert!(!dir.join(CONNECTIONS_FILE).exists());

        // Update with a new secret when the keychain fails: metadata unchanged.
        k.fail_on(FailOn::default());
        let c = s.save(static_input(None, "A", SECRET)).await.expect("create");
        k.fail_on(FailOn { set: true, ..Default::default() });
        assert_eq!(s.save(static_input(Some(&c.id), "Renamed", "x")).await.expect_err("kc").code, ErrorCode::Keychain);
        k.fail_on(FailOn::default());
        let list = s.list().await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "A");
        assert_eq!(k.peek(&c.id).map(|s| s.expose().to_string()), Some(SECRET.into()));
        // Profile connections never touch the keychain, so they save even when it is unavailable.
        k.fail_on(FailOn { set: true, get: true, delete: true });
        s.save(profile_input(None, "P")).await.expect("profile saves without keychain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store whose config dir is a regular file, so every metadata write fails.
    fn broken_store(dir: &Path, k: Arc<MemoryKeychain>) -> ConnectionStore {
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").expect("write");
        ConnectionStore::load(blocker.join(CONNECTIONS_FILE), k)
    }

    #[tokio::test]
    async fn metadata_failure_rolls_back_keychain() {
        let dir = temp_dir("metafail");
        let k = Arc::new(MemoryKeychain::new());
        let s = broken_store(&dir, k.clone());
        let e = s.save(static_input(None, "A", SECRET)).await.expect_err("io");
        assert_eq!(e.code, ErrorCode::Io);
        assert!(k.is_empty(), "new keychain entry rolled back");
        assert!(s.list().await.expect("list").is_empty());

        // Update with a new secret on a broken disk: the old secret is restored.
        let ok_dir = temp_dir("metafail-ok");
        let good = ConnectionStore::load(ok_dir.join(CONNECTIONS_FILE), k.clone());
        let c = good.save(static_input(None, "A", SECRET)).await.expect("create");
        let text = std::fs::read_to_string(ok_dir.join(CONNECTIONS_FILE)).expect("read");
        let blocker_path = dir.join("blocker");
        // Same metadata in a store that cannot write.
        let s = ConnectionStore {
            path: Some(blocker_path.join(CONNECTIONS_FILE)),
            keychain: k.clone(),
            items: tokio::sync::Mutex::new(load_file(&ok_dir.join(CONNECTIONS_FILE))),
        };
        assert!(text.contains(&c.id));
        assert_eq!(s.save(static_input(Some(&c.id), "A", "other")).await.expect_err("io").code, ErrorCode::Io);
        assert_eq!(k.peek(&c.id).map(|s| s.expose().to_string()), Some(SECRET.into()), "old secret restored");
        // Delete on a broken disk: the secret is put back and the entry stays.
        assert_eq!(s.delete(&c.id).await.expect_err("io").code, ErrorCode::Io);
        assert_eq!(k.peek(&c.id).map(|s| s.expose().to_string()), Some(SECRET.into()));
        assert_eq!(s.list().await.expect("list").len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&ok_dir);
    }

    #[tokio::test]
    async fn delete_rules() {
        let dir = temp_dir("delete");
        let (s, k) = store(&dir);
        let a = s.save(static_input(None, "A", SECRET)).await.expect("a");
        let b = s.save(static_input(None, "B", SECRET)).await.expect("b");
        let p = s.save(profile_input(None, "P")).await.expect("p");
        s.delete("unknown-id").await.expect("unknown id is a no-op");
        assert_eq!(s.list().await.expect("list").len(), 3);

        s.delete(&a.id).await.expect("delete");
        assert!(k.peek(&a.id).is_none(), "keychain entry removed");
        assert!(k.peek(&b.id).is_some(), "others untouched");
        // Missing keychain entry is fine.
        k.remove_externally(&b.id);
        s.delete(&b.id).await.expect("delete without secret");
        s.delete(&p.id).await.expect("delete profile");
        assert!(s.list().await.expect("list").is_empty());
        assert!(k.is_empty());
        let reloaded = ConnectionStore::load(dir.join(CONNECTIONS_FILE), k.clone());
        assert!(reloaded.list().await.expect("list").is_empty(), "deletion persisted");

        // Keychain failure on delete: nothing changes.
        let c = s.save(static_input(None, "C", SECRET)).await.expect("c");
        k.fail_on(FailOn { delete: true, ..Default::default() });
        assert_eq!(s.delete(&c.id).await.expect_err("kc").code, ErrorCode::Keychain);
        k.fail_on(FailOn::default());
        assert_eq!(s.list().await.expect("list").len(), 1);
        assert!(k.peek(&c.id).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn has_secret_and_sorting() {
        let dir = temp_dir("sort");
        let (s, k) = store(&dir);
        let never_b = s.save(profile_input(None, "beta")).await.expect("b");
        let never_a = s.save(static_input(None, "Alpha", SECRET)).await.expect("a");
        let used_old = s.save(static_input(None, "zeta", SECRET)).await.expect("z");
        let used_new = s.save(profile_input(None, "gamma")).await.expect("g");
        s.mark_used(&used_old.id).await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        s.mark_used(&used_new.id).await;
        k.remove_externally(&never_a.id);

        let list = s.list().await.expect("list");
        let names: Vec<&str> = list.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["gamma", "zeta", "Alpha", "beta"]);
        let by = |id: &str| list.iter().find(|c| c.id == id).expect("present").clone();
        assert!(!by(&never_b.id).has_secret, "profile: no secret needed");
        assert!(!by(&never_a.id).has_secret, "secret removed from keychain");
        assert!(by(&used_old.id).has_secret);
        // A keychain that cannot be read reports hasSecret false instead of failing the list.
        k.fail_on(FailOn { get: true, ..Default::default() });
        assert!(s.list().await.expect("list").iter().all(|c| !c.has_secret));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resolve_and_missing_secret() {
        let dir = temp_dir("resolve");
        let (s, k) = store(&dir);
        let c = s.save(static_input(None, "S", SECRET)).await.expect("s");
        let (name, cfg) = s.resolve(&c.id).await.expect("resolve");
        assert_eq!(name, "S");
        match &cfg {
            ConnectionConfig::Static {
                access_key_id,
                secret_access_key,
                session_token,
                region,
                endpoint,
                force_path_style,
            } => {
                assert_eq!(access_key_id, "AKIAEXAMPLE");
                assert_eq!(secret_access_key, SECRET);
                assert!(session_token.is_none());
                assert_eq!(region, "eu-west-1");
                assert_eq!(endpoint.as_deref(), Some("http://127.0.0.1:8333"));
                assert_eq!(*force_path_style, Some(false));
            }
            ConnectionConfig::Profile { .. } => panic!("expected static"),
        }
        assert!(!format!("{cfg:?}").contains(SECRET), "ConnectionConfig Debug is redacted");

        k.remove_externally(&c.id);
        let e = s.resolve(&c.id).await.expect_err("missing");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.contains("secret"), "{}", e.message);
        k.fail_on(FailOn { get: true, ..Default::default() });
        assert_eq!(s.resolve(&c.id).await.expect_err("kc").code, ErrorCode::Keychain);
        assert_eq!(s.resolve("nope").await.expect_err("unknown").message, msg::UNKNOWN_ID);

        let p = s.save(profile_input(None, "P")).await.expect("p");
        let (_, cfg) = s.resolve(&p.id).await.expect("profile resolves without keychain");
        assert!(matches!(cfg, ConnectionConfig::Profile { ref profile, region: None, endpoint: None } if profile == "dev"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn lenient_load() {
        let dir = temp_dir("lenient");
        let path = dir.join(CONNECTIONS_FILE);
        let k: Arc<MemoryKeychain> = Arc::new(MemoryKeychain::new());
        for corrupt in ["", "{", "null", "[]", r#"{"connections": 5}"#] {
            std::fs::write(&path, corrupt).expect("write");
            let s = ConnectionStore::load(path.clone(), k.clone());
            assert!(s.list().await.expect("list").is_empty(), "{corrupt}");
        }
        std::fs::write(
            &path,
            r#"{"version": 9, "future": true, "connections": [
                {"id": "a", "name": "A", "kind": "profile", "profile": "dev", "extra": 1},
                {"id": "b", "name": "B", "kind": "teleport"},
                {"id": "a", "name": "Dup", "kind": "profile", "profile": "x"},
                {"id": "", "name": "NoId", "kind": "profile"},
                "garbage",
                {"id": "c", "name": "C", "kind": "static", "accessKeyId": "AK"}
            ]}"#,
        )
        .expect("write");
        let s = ConnectionStore::load(path.clone(), k.clone());
        let names: Vec<String> = s.list().await.expect("list").into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["A", "C"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
