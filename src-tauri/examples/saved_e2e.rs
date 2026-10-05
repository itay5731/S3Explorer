//! End-to-end check of saved connections against a local S3-compatible server (SeaweedFS) and the
//! real OS keychain, under the TEST service name `dev.s3explorer.app.test` and a temp config dir.
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin).
//!
//! Run: `cargo run --example saved_e2e`

use std::sync::Arc;

use s3explorer_lib::error::ErrorCode;
use s3explorer_lib::jobs::JobSink;
use s3explorer_lib::keychain::{OsKeychain, SecretStore, KEYCHAIN_SERVICE};
use s3explorer_lib::models::{ConnectionConfig, Job, SaveConnectionInput, Transfer};
use s3explorer_lib::saved::{self, ConnectionStore, CONNECTIONS_FILE};
use s3explorer_lib::settings::SettingsStore;
use s3explorer_lib::state::AppState;
use s3explorer_lib::transfers::ProgressSink;

const TEST_SERVICE: &str = "dev.s3explorer.app.test";

type Res<T> = Result<T, Box<dyn std::error::Error>>;

struct Nop;
impl ProgressSink for Nop {
    fn emit(&self, _: &Transfer) {}
}
impl JobSink for Nop {
    fn emit(&self, _: &Job) {}
}

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

#[tokio::main]
async fn main() {
    assert_ne!(TEST_SERVICE, KEYCHAIN_SERVICE);
    let dir = std::env::temp_dir().join(format!("s3explorer-saved-e2e-{}", uuid::Uuid::new_v4().simple()));
    let keychain = Arc::new(OsKeychain::with_service(TEST_SERVICE));
    let mut created: Vec<String> = Vec::new();
    let result = run(&dir, keychain.clone(), &mut created).await;

    for id in &created {
        let _ = keychain.delete(id);
    }
    let leftover = created.iter().filter(|id| matches!(keychain.get(id), Ok(Some(_)))).count();
    let _ = std::fs::remove_dir_all(&dir);
    match result {
        Ok(()) if leftover == 0 => println!("SAVED CONNECTIONS E2E PASSED (no keychain entries left)"),
        Ok(()) => {
            eprintln!("FAILED: {leftover} keychain entries left");
            std::process::exit(1)
        }
        Err(e) => {
            eprintln!("{e}");
            eprintln!("SAVED CONNECTIONS E2E FAILED (cleanup done, {leftover} keychain entries left)");
            std::process::exit(1)
        }
    }
}

async fn run(dir: &std::path::Path, keychain: Arc<OsKeychain>, created: &mut Vec<String>) -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let access = env("SMOKE_ACCESS_KEY", "minioadmin");
    let secret = env("SMOKE_SECRET_KEY", "minioadmin");
    let path = dir.join(CONNECTIONS_FILE);
    let store = ConnectionStore::load(path.clone(), keychain.clone());
    let state = AppState::new(Arc::new(Nop), Arc::new(Nop), SettingsStore::in_memory(Default::default()));

    let input = |id: Option<&str>, name: &str, secret: &str| SaveConnectionInput {
        id: id.map(str::to_string),
        name: name.to_string(),
        config: ConnectionConfig::Static {
            access_key_id: access.clone(),
            secret_access_key: secret.to_string(),
            session_token: None,
            region: "us-east-1".into(),
            endpoint: Some(endpoint.clone()),
            force_path_style: Some(true),
        },
    };

    println!("save a static connection");
    let c = store.save(input(None, "Local Seaweed", &secret)).await?;
    created.push(c.id.clone());
    check(c.has_secret, "hasSecret true after save")?;
    check(matches!(keychain.get(&c.id), Ok(Some(ref s)) if s.expose() == secret), "secret is in the OS keychain")?;
    let text = std::fs::read_to_string(&path)?;
    check(text.contains(&c.id) && text.contains(&access), "metadata written to connections.json")?;
    check(!text.contains("\"secret") && !text.to_lowercase().contains("secretaccesskey"), "no secret field in the file")?;
    if secret != access {
        check(!text.contains(&secret), "secret value not in the file")?;
    }

    println!("connect_saved");
    let info = saved::connect_saved(&store, &state, &c.id).await?;
    check(info.label == "Local Seaweed", &format!("label is the saved name ({})", info.label))?;
    check(info.can_list_buckets, "canListBuckets")?;
    let conn = state.connection().await?;
    let buckets = conn.base_client().list_buckets().send().await?;
    println!("  buckets: {:?}", buckets.buckets().iter().filter_map(|b| b.name()).collect::<Vec<_>>());
    check(true, "list_buckets through the saved connection")?;
    let listed = store.list().await?;
    check(listed[0].id == c.id && listed[0].last_used_at.is_some(), "lastUsedAt set after connect")?;

    println!("update keeping the secret (empty secretAccessKey)");
    let u = store.save(input(Some(&c.id), "Local Seaweed (renamed)", "")).await?;
    check(u.id == c.id && u.has_secret, "same id, secret kept")?;
    check(u.last_used_at == listed[0].last_used_at, "lastUsedAt kept on update")?;
    state.set_connection(None).await;
    let info = saved::connect_saved(&store, &state, &c.id).await?;
    check(info.label == "Local Seaweed (renamed)", "connect after update uses the kept secret")?;

    println!("wrong secret: connect fails, lastUsedAt unchanged");
    let before = store.list().await?[0].last_used_at.clone();
    let bad = store.save(input(None, "Bad secret", "definitely-wrong-secret")).await?;
    created.push(bad.id.clone());
    let e = saved::connect_saved(&store, &state, &bad.id).await.expect_err("bad secret must fail");
    println!("  error: {:?} {}", e.code, e.message);
    check(e.code == ErrorCode::Auth || e.code == ErrorCode::AccessDenied, "rejected by the server")?;
    check(!e.message.contains("definitely-wrong-secret"), "error message does not contain the secret")?;
    let after = store.list().await?;
    let bad_now = after.iter().find(|x| x.id == bad.id).ok_or("bad entry gone")?;
    check(bad_now.last_used_at.is_none(), "failed connect does not set lastUsedAt")?;
    check(after.iter().find(|x| x.id == c.id).ok_or("c gone")?.last_used_at == before, "other entry untouched")?;

    println!("missing secret: InvalidInput mentioning \"secret\"");
    keychain.delete(&bad.id)?;
    check(!store.list().await?.iter().find(|x| x.id == bad.id).ok_or("gone")?.has_secret, "hasSecret false")?;
    let e = saved::connect_saved(&store, &state, &bad.id).await.expect_err("missing secret");
    println!("  error: {:?} {}", e.code, e.message);
    check(e.code == ErrorCode::InvalidInput && e.message.contains("secret"), "InvalidInput with \"secret\"")?;

    println!("delete");
    store.delete(&c.id).await?;
    store.delete(&bad.id).await?;
    check(matches!(keychain.get(&c.id), Ok(None)), "keychain entry removed by delete")?;
    check(store.list().await?.is_empty(), "list empty")?;
    let reloaded = ConnectionStore::load(path.clone(), keychain.clone());
    check(reloaded.list().await?.is_empty(), "deletion persisted")?;
    let e = saved::connect_saved(&store, &state, &c.id).await.expect_err("deleted");
    check(e.code == ErrorCode::InvalidInput, "connect_saved on a deleted id is InvalidInput")?;
    check(state.connection_info().await.is_some(), "deleting does not disconnect the active session")?;
    Ok(())
}
