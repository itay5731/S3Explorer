//! OS keychain access for saved-connection secrets.
//!
//! [`SecretStore`] is the seam: the app uses [`OsKeychain`] (the `keyring` crate's native store:
//! Windows Credential Manager, macOS Keychain, Linux Secret Service); unit tests use
//! [`MemoryKeychain`], which can also simulate failures.
//!
//! Secrets travel as [`Secret`], whose `Debug` never prints the value. Every failure maps to
//! `ErrorCode::Keychain` with a short message that never contains secret material (the UI adds
//! its own explanation in front of it).

use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{AppError, ErrorCode};

/// Keychain service name for saved-connection secrets; the account is the connection id.
pub const KEYCHAIN_SERVICE: &str = "dev.s3explorer.app";

/// A secret value. `Debug` is redacted; the only way to read it is [`Secret::expose`].
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Blocking secret storage keyed by account (connection id). Callers run it off the async runtime.
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &Secret) -> Result<(), AppError>;
    /// `Ok(None)` when there is no entry for `account`.
    fn get(&self, account: &str) -> Result<Option<Secret>, AppError>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

fn keychain_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Keychain, message)
}

/// Short, user-readable text for a keyring error. Platform details are included (cut short)
/// because they help diagnose a locked or missing keychain; they never contain the secret.
fn describe(e: &keyring::Error) -> AppError {
    use keyring::Error as E;
    let short = |s: String| -> String {
        let s = s.trim().to_string();
        if s.chars().count() > 160 {
            format!("{}…", s.chars().take(160).collect::<String>())
        } else {
            s
        }
    };
    match e {
        E::NoStorageAccess(inner) => keychain_error(format!("Access to the keychain was denied ({}).", short(inner.to_string()))),
        E::PlatformFailure(inner) => keychain_error(format!("The keychain reported an error ({}).", short(inner.to_string()))),
        E::NoDefaultStore => keychain_error("No keychain is available on this system."),
        E::BadEncoding(_) | E::BadDataFormat(..) => keychain_error("The stored secret could not be read."),
        E::TooLong(..) => keychain_error("The secret is too long for the keychain."),
        E::Ambiguous(_) => keychain_error("The keychain holds more than one entry for this connection."),
        E::NoEntry => keychain_error("The keychain entry was not found."),
        _ => keychain_error("The keychain rejected the request."),
    }
}

/// The platform keychain via the `keyring` crate.
pub struct OsKeychain {
    service: String,
}

impl OsKeychain {
    /// The app's real store (`dev.s3explorer.app`).
    pub fn new() -> Self {
        Self::with_service(KEYCHAIN_SERVICE)
    }

    /// A store under another service name (integration checks use `dev.s3explorer.app.test`
    /// so they can never touch real entries).
    pub fn with_service(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(&self.service, account).map_err(|e| describe(&e))
    }
}

impl Default for OsKeychain {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for OsKeychain {
    fn set(&self, account: &str, secret: &Secret) -> Result<(), AppError> {
        self.entry(account)?.set_password(secret.expose()).map_err(|e| describe(&e))
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, AppError> {
        match self.entry(account)?.get_password() {
            Ok(p) => Ok(Some(Secret::new(p))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(describe(&e)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(&e)),
        }
    }
}

/// Which operations a [`MemoryKeychain`] should fail (tests).
#[derive(Debug, Default, Clone, Copy)]
pub struct FailOn {
    pub set: bool,
    pub get: bool,
    pub delete: bool,
}

/// In-memory store for unit tests, with failure injection.
#[derive(Default)]
pub struct MemoryKeychain {
    entries: Mutex<HashMap<String, Secret>>,
    fail: Mutex<FailOn>,
}

impl MemoryKeychain {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn fail_on(&self, fail: FailOn) {
        *self.fail.lock().unwrap_or_else(|p| p.into_inner()) = fail;
    }
    fn failing(&self) -> FailOn {
        *self.fail.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Secret>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Test helper: the stored value, bypassing failure injection.
    pub fn peek(&self, account: &str) -> Option<Secret> {
        self.map().get(account).cloned()
    }
    pub fn len(&self) -> usize {
        self.map().len()
    }
    pub fn is_empty(&self) -> bool {
        self.map().is_empty()
    }
    /// Test helper: removes an entry behind the store's back (e.g. deleted by the user in the OS).
    pub fn remove_externally(&self, account: &str) {
        self.map().remove(account);
    }
}

impl SecretStore for MemoryKeychain {
    fn set(&self, account: &str, secret: &Secret) -> Result<(), AppError> {
        if self.failing().set {
            return Err(keychain_error("The keychain is locked (test)."));
        }
        self.map().insert(account.to_string(), secret.clone());
        Ok(())
    }
    fn get(&self, account: &str) -> Result<Option<Secret>, AppError> {
        if self.failing().get {
            return Err(keychain_error("The keychain is locked (test)."));
        }
        Ok(self.map().get(account).cloned())
    }
    fn delete(&self, account: &str) -> Result<(), AppError> {
        if self.failing().delete {
            return Err(keychain_error("The keychain is locked (test)."));
        }
        self.map().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_is_redacted() {
        let s = Secret::new("wJalrXUtnFEMI/K7MDENG");
        let d = format!("{s:?}");
        assert!(!d.contains("wJalr"), "{d}");
        assert_eq!(s.expose(), "wJalrXUtnFEMI/K7MDENG");
    }

    #[test]
    fn memory_store_semantics() {
        let k = MemoryKeychain::new();
        assert_eq!(k.get("a").expect("get"), None);
        k.delete("a").expect("deleting a missing entry is fine");
        k.set("a", &Secret::new("one")).expect("set");
        k.set("a", &Secret::new("two")).expect("overwrite");
        assert_eq!(k.get("a").expect("get").map(|s| s.expose().to_string()), Some("two".into()));
        k.delete("a").expect("delete");
        assert!(k.is_empty());
        k.fail_on(FailOn { set: true, ..Default::default() });
        let e = k.set("a", &Secret::new("x")).expect_err("fails");
        assert_eq!(e.code, ErrorCode::Keychain);
        assert!(k.is_empty());
    }

    #[test]
    fn keyring_errors_map_to_keychain_code() {
        for e in [keyring::Error::NoDefaultStore, keyring::Error::NoEntry, keyring::Error::BadEncoding(vec![1, 2])] {
            let a = describe(&e);
            assert_eq!(a.code, ErrorCode::Keychain);
            assert!(!a.message.is_empty() && a.message.len() < 250, "{}", a.message);
        }
    }
}
