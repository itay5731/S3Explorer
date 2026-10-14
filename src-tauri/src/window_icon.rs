//! v0.9.0 "Window icon follows the accent": the bundled icon of each accent colour.
//!
//! The PNGs are compiled into the executable (no file access): a 32 px one for the title bar and a
//! 256 px one for the taskbar / Alt-Tab (and the only one used on macOS and Linux).

use crate::error::{AppError, AppResult};
use crate::models::AccentColor;

/// The accent named by the frontend, `InvalidInput` for anything else.
pub fn parse_accent(name: &str) -> AppResult<AccentColor> {
    AccentColor::parse(name)
        .ok_or_else(|| AppError::invalid(format!(r#"accent must be "yellow", "green", "blue" or "red", not {name:?}"#)))
}

/// (32 px, 256 px) PNG bytes for `accent`.
pub fn icon_png(accent: AccentColor) -> (&'static [u8], &'static [u8]) {
    match accent {
        AccentColor::Yellow => {
            (include_bytes!("../icons/accent/yellow-32.png"), include_bytes!("../icons/accent/yellow-256.png"))
        }
        AccentColor::Green => (include_bytes!("../icons/accent/green-32.png"), include_bytes!("../icons/accent/green-256.png")),
        AccentColor::Blue => (include_bytes!("../icons/accent/blue-32.png"), include_bytes!("../icons/accent/blue-256.png")),
        AccentColor::Red => (include_bytes!("../icons/accent/red-32.png"), include_bytes!("../icons/accent/red-256.png")),
    }
}

/// Decodes one bundled PNG (`Io`-free: the bytes are in the executable).
pub fn decode(png: &'static [u8]) -> AppResult<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(png).map_err(|e| AppError::new(crate::error::ErrorCode::Unknown, format!("Bundled icon is unreadable: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn accents_parse_and_others_are_invalid() {
        for (name, want) in [
            ("yellow", AccentColor::Yellow),
            ("green", AccentColor::Green),
            ("blue", AccentColor::Blue),
            ("red", AccentColor::Red),
        ] {
            assert_eq!(parse_accent(name).expect(name), want);
        }
        for bad in ["", "Yellow", "purple", " red", "red "] {
            assert_eq!(parse_accent(bad).expect_err(bad).code, ErrorCode::InvalidInput, "{bad:?}");
        }
    }

    #[test]
    fn all_eight_bundled_icons_decode_as_png() {
        for accent in [AccentColor::Yellow, AccentColor::Green, AccentColor::Blue, AccentColor::Red] {
            let (small, big) = icon_png(accent);
            for (png, size) in [(small, 32), (big, 256)] {
                assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"), "{accent:?} {size}: not a PNG");
                let img = decode(png).unwrap_or_else(|e| panic!("{accent:?} {size}: {}", e.message));
                assert_eq!((img.width(), img.height()), (size, size), "{accent:?}");
                assert_eq!(img.rgba().len(), (size * size * 4) as usize);
            }
        }
    }
}
