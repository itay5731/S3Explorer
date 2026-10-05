//! Exercises the real OS keychain through `OsKeychain` (Windows Credential Manager here).
//!
//! Uses the service name `dev.s3explorer.app.test`, never the app's real one, and removes every
//! entry it creates (also on failure). Run: `cargo run --example keychain_check`.

use s3explorer_lib::keychain::{OsKeychain, Secret, SecretStore, KEYCHAIN_SERVICE};

const TEST_SERVICE: &str = "dev.s3explorer.app.test";

fn main() {
    assert_ne!(TEST_SERVICE, KEYCHAIN_SERVICE, "must never touch the real service");
    let k = OsKeychain::with_service(TEST_SERVICE);
    let accounts: Vec<String> = (0..2).map(|_| uuid::Uuid::new_v4().to_string()).collect();

    let result = std::panic::catch_unwind(|| run(&k, &accounts));

    // Cleanup no matter what happened.
    for a in &accounts {
        let _ = k.delete(a);
    }
    for a in &accounts {
        assert_eq!(k.get(a).expect("get after cleanup").map(|_| ()), None, "cleanup left {a}");
    }
    match result {
        Ok(()) => println!("KEYCHAIN CHECK PASSED (service {TEST_SERVICE}, all entries removed)"),
        Err(_) => {
            eprintln!("KEYCHAIN CHECK FAILED (entries removed)");
            std::process::exit(1);
        }
    }
}

fn run(k: &OsKeychain, accounts: &[String]) {
    let (a, b) = (&accounts[0], &accounts[1]);
    println!("service={} accounts={a}, {b}", k.service());

    assert_eq!(k.get(a).expect("get missing").map(|_| ()), None, "fresh account is empty");
    k.delete(a).expect("deleting a missing entry is not an error");
    println!("ok: missing entry -> None; delete missing -> Ok");

    let s1 = "secret-one/with+chars=and unicode é ✓";
    k.set(a, &Secret::new(s1)).expect("set");
    assert_eq!(k.get(a).expect("get").expect("present").expose(), s1);
    println!("ok: set + get round trip (unicode)");

    let s2 = "x".repeat(200);
    k.set(a, &Secret::new(s2.clone())).expect("overwrite");
    assert_eq!(k.get(a).expect("get").expect("present").expose(), s2);
    println!("ok: overwrite replaces the value");

    k.set(b, &Secret::new("other")).expect("set b");
    assert_eq!(k.get(b).expect("get b").expect("present b").expose(), "other");
    assert_eq!(k.get(a).expect("get a").expect("present a").expose(), s2, "entries are independent");
    println!("ok: two accounts are independent");

    #[cfg(windows)]
    {
        let out = std::process::Command::new("cmdkey").arg("/list").output().expect("cmdkey");
        let text = String::from_utf8_lossy(&out.stdout);
        let hit = text.lines().any(|l| l.contains(a.as_str()) && l.contains(TEST_SERVICE));
        println!("cmdkey shows `{a}.{TEST_SERVICE}`: {hit}");
        assert!(hit, "entry should be visible in Credential Manager while it exists");
        assert!(!text.contains(s1) && !text.contains(&s2), "cmdkey never prints the secret");
    }

    k.delete(a).expect("delete a");
    assert_eq!(k.get(a).expect("get deleted").map(|_| ()), None);
    k.delete(a).expect("delete again is fine");
    k.delete(b).expect("delete b");
    assert_eq!(k.get(b).expect("get deleted b").map(|_| ()), None);
    println!("ok: delete removes entries; repeated delete is Ok");
}
