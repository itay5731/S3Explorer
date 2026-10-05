fn main() {
    // Examples that build a (mock) Tauri app (examples/updater_check.rs) need the Common Controls v6
    // manifest on Windows, like the app binary gets from tauri-build; without it they exit with
    // STATUS_ENTRYPOINT_NOT_FOUND. Applies to examples only, never to the shipped binary.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
    tauri_build::build()
}
