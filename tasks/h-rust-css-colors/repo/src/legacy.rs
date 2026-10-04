//! The 0.3 tuple-based API, kept for existing callers until 1.0.

use crate::color::Rgba;
use crate::{named, parse};

/// Parses `#rgb` or `#rrggbb` into a channel tuple.
#[deprecated(since = "0.4.0", note = "use `chroma::parse` instead")]
pub fn hex_to_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let c = parse::parse(hex).ok()?;
    if !hex.trim_start().starts_with('#') || !c.is_opaque() {
        return None;
    }
    Some((c.r, c.g, c.b))
}

/// Formats a channel tuple as lowercase `#rrggbb`.
#[deprecated(since = "0.4.0", note = "use `Rgba::to_hex` instead")]
pub fn rgb_to_hex(r: u8, g: u8, b: u8) -> String {
    Rgba::rgb(r, g, b).to_hex()
}

/// The `#rrggbb` value of a named color.
#[deprecated(since = "0.4.0", note = "use `chroma::parse` instead")]
pub fn named_to_hex(name: &str) -> Option<String> {
    named::lookup(&name.to_ascii_lowercase()).map(|c| c.to_hex())
}

/// HSL as `(hue degrees, saturation %, lightness %)`.
#[deprecated(since = "0.4.0", note = "use `Rgba::to_hsla` instead")]
pub fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let h = Rgba::rgb(r, g, b).to_hsla();
    (h.h, h.s, h.l)
}
