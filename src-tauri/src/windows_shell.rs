//! How the Windows shell identifies the app: the taskbar icon of the window and the process's
//! AppUserModelID. Both are no-ops on other platforms.
//!
//! Tauri sets only the window's small icon (`ICON_SMALL`, drawn in the title bar) and leaves the
//! large icon (`ICON_BIG`) and the window class icons empty. With no large icon the taskbar falls
//! back to the icon the shell has cached for the executable path or its shortcut, which survives an
//! upgrade in place and keeps showing the icon of the previously installed version.
//!
//! The installers stamp `System.AppUserModel.ID = <bundle identifier>` on the Start menu and
//! desktop shortcuts, but the process itself had no explicit AppUserModelID, so a launch that does
//! not go through a shortcut (the installer's "Run" checkbox, the restart after an in-app update)
//! was not tied to the pinned shortcut.

/// Sets the process-wide AppUserModelID to the bundle identifier, matching the ID the installers
/// write on the shortcuts. Must run before the first window is created.
///
/// Skipped for builds run from `target\debug` or `target\release`, the same rule
/// `tauri-plugin-notification` uses, so a development build is never grouped with (or shown under
/// the pinned shortcut of) the installed app.
pub fn set_app_user_model_id(identifier: &str) {
    #[cfg(windows)]
    {
        if running_from_cargo_target() {
            return;
        }
        let wide: Vec<u16> = identifier
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call; the function
        // copies it.
        let hr = unsafe { ffi::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
        if hr < 0 {
            log_failure("SetCurrentProcessExplicitAppUserModelID", hr as i64);
        }
    }
    #[cfg(not(windows))]
    let _ = identifier;
}

/// Gives every open window the application icon resource as its large (taskbar / Alt+Tab) icon,
/// loaded from this executable so it is always the icon of the running version.
pub fn set_taskbar_icons<R: tauri::Runtime>(app: &tauri::App<R>) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        for window in app.webview_windows().values() {
            match window.hwnd() {
                Ok(hwnd) => set_big_icon(hwnd.0 as isize),
                Err(e) => eprintln!("could not get the window handle to set the taskbar icon: {e}"),
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
fn set_big_icon(hwnd: isize) {
    // SAFETY: plain Win32 calls. A null module handle means this executable; the resource ID is
    // the one tauri-build embeds the application icon under. The icon is shared (LR_SHARED), so it
    // is owned by the system and must not be destroyed.
    unsafe {
        let width = ffi::GetSystemMetrics(ffi::SM_CXICON);
        let height = ffi::GetSystemMetrics(ffi::SM_CYICON);
        let module = ffi::GetModuleHandleW(std::ptr::null());
        let icon = ffi::LoadImageW(
            module,
            tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as usize as *const u16,
            ffi::IMAGE_ICON,
            width,
            height,
            ffi::LR_SHARED,
        );
        if icon == 0 {
            log_failure("LoadImageW(application icon)", 0);
            return;
        }
        ffi::SendMessageW(hwnd, ffi::WM_SETICON, ffi::ICON_BIG, icon);
    }
}

/// v0.9.0: makes the window's large (taskbar / Alt+Tab) icon an icon built from `rgba` (straight
/// alpha, `width` x `height`), destroying the one this function set before. Tauri's `set_icon`
/// only replaces the small (title bar) icon on Windows.
#[cfg(windows)]
pub fn set_big_icon_rgba(hwnd: isize, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    use std::sync::atomic::{AtomicIsize, Ordering};
    /// The large icon this function created last (0 = none): released when replaced.
    static CREATED: AtomicIsize = AtomicIsize::new(0);

    if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err("The icon image has the wrong size".into());
    }
    // Windows wants BGRA; the AND mask is all zeros (transparency comes from the alpha channel).
    let mut bgra = rgba.to_vec();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    // Mask rows are padded to 16 bits.
    let mask_row = (width as usize).div_ceil(16) * 2;
    let mask = vec![0u8; mask_row * height as usize];
    // SAFETY: both buffers are as large as the sizes passed say; the icon is owned by us and
    // destroyed only after the window no longer uses it.
    unsafe {
        let icon = ffi::CreateIcon(0, width as i32, height as i32, 1, 32, mask.as_ptr(), bgra.as_ptr());
        if icon == 0 {
            return Err("CreateIcon failed".into());
        }
        ffi::SendMessageW(hwnd, ffi::WM_SETICON, ffi::ICON_BIG, icon);
        let previous = CREATED.swap(icon, Ordering::SeqCst);
        if previous != 0 {
            ffi::DestroyIcon(previous);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn running_from_cargo_target() -> bool {
    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return false;
    };
    exe.parent().is_some_and(|dir| {
        dir.ends_with(std::path::Path::new("target").join("debug"))
            || dir.ends_with(std::path::Path::new("target").join("release"))
    })
}

#[cfg(windows)]
fn log_failure(what: &str, code: i64) {
    // No logger is installed; stderr is visible in development and harmless in release.
    eprintln!("{what} failed (code {code:#x})");
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod ffi {
    pub const SM_CXICON: i32 = 11;
    pub const SM_CYICON: i32 = 12;
    pub const IMAGE_ICON: u32 = 1;
    pub const LR_SHARED: u32 = 0x8000;
    pub const WM_SETICON: u32 = 0x0080;
    pub const ICON_BIG: usize = 1;

    #[link(name = "user32")]
    extern "system" {
        pub fn GetSystemMetrics(index: i32) -> i32;
        pub fn LoadImageW(
            instance: isize,
            name: *const u16,
            kind: u32,
            cx: i32,
            cy: i32,
            load: u32,
        ) -> isize;
        pub fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
        pub fn CreateIcon(
            instance: isize,
            width: i32,
            height: i32,
            planes: u8,
            bits_per_pixel: u8,
            and_bits: *const u8,
            xor_bits: *const u8,
        ) -> isize;
        pub fn DestroyIcon(icon: isize) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetModuleHandleW(name: *const u16) -> isize;
    }

    #[link(name = "shell32")]
    extern "system" {
        pub fn SetCurrentProcessExplicitAppUserModelID(id: *const u16) -> i32;
        #[cfg(test)]
        pub fn GetCurrentProcessExplicitAppUserModelID(id: *mut *mut u16) -> i32;
    }

    #[cfg(test)]
    #[link(name = "ole32")]
    extern "system" {
        pub fn CoTaskMemFree(ptr: *mut core::ffi::c_void);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn current_id() -> Option<String> {
        let mut ptr: *mut u16 = std::ptr::null_mut();
        // SAFETY: on success the shell allocates a NUL-terminated string we free with CoTaskMemFree.
        unsafe {
            if ffi::GetCurrentProcessExplicitAppUserModelID(&mut ptr) < 0 || ptr.is_null() {
                return None;
            }
            let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
            let id = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
            ffi::CoTaskMemFree(ptr.cast());
            Some(id)
        }
    }

    #[test]
    fn a_big_icon_needs_a_matching_buffer() {
        assert!(set_big_icon_rgba(0, &[0; 15], 2, 2).is_err());
        assert!(set_big_icon_rgba(0, &[], 0, 0).is_err());
    }

    /// The test binary lives in `target\debug\deps`, not `target\debug`, so it counts as an
    /// installed copy and the ID must be set and read back unchanged.
    #[test]
    fn sets_the_process_app_user_model_id_outside_cargo_target() {
        assert!(!running_from_cargo_target());
        set_app_user_model_id("dev.s3explorer.app");
        assert_eq!(current_id().as_deref(), Some("dev.s3explorer.app"));
    }
}
