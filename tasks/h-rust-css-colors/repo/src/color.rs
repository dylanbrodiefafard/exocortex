//! Color types and conversions.

use std::fmt;

/// An sRGB color with 8-bit channels and a straight (non-premultiplied) alpha in `0.0..=1.0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f64,
}

/// Hue in degrees `0.0..360.0`, saturation and lightness in percent `0.0..=100.0`, alpha in `0.0..=1.0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hsla {
    pub h: f64,
    pub s: f64,
    pub l: f64,
    pub a: f64,
}

/// Converts a unit value (`0.0..=1.0`, clamped) to a channel byte, rounding to nearest.
pub(crate) fn unit_to_byte(x: f64) -> u8 {
    (x.clamp(0.0, 1.0) * 255.0).round() as u8
}

pub(crate) fn clamp_alpha(a: f64) -> f64 {
    if a.is_nan() {
        return 1.0;
    }
    a.clamp(0.0, 1.0)
}

impl Rgba {
    /// An opaque color.
    pub const fn rgb(r: u8, g: u8, b: u8) -> Rgba {
        Rgba { r, g, b, a: 1.0 }
    }

    /// A color with the given alpha (clamped to `0.0..=1.0`).
    pub fn rgba(r: u8, g: u8, b: u8, a: f64) -> Rgba {
        Rgba { r, g, b, a: clamp_alpha(a) }
    }

    /// Whether the color is fully opaque.
    pub fn is_opaque(&self) -> bool {
        self.a >= 1.0
    }

    /// Lowercase hex: `#rrggbb` when opaque, `#rrggbbaa` otherwise, with the alpha byte
    /// rounded to nearest.
    pub fn to_hex(&self) -> String {
        if self.is_opaque() {
            format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
        } else {
            format!("#{:02x}{:02x}{:02x}{:02x}", self.r, self.g, self.b, (self.a * 255.0) as u8)
        }
    }

    /// `rgb(r, g, b)` when opaque, `rgba(r, g, b, a)` otherwise (alpha with at most three
    /// decimals, trailing zeros removed).
    pub fn to_css(&self) -> String {
        if self.is_opaque() {
            format!("rgb({}, {}, {})", self.r, self.g, self.b)
        } else {
            format!("rgba({}, {}, {}, {})", self.r, self.g, self.b, format_alpha(self.a))
        }
    }

    /// Converts to HSL. Achromatic colors get hue 0 and saturation 0.
    pub fn to_hsla(&self) -> Hsla {
        let r = f64::from(self.r) / 255.0;
        let g = f64::from(self.g) / 255.0;
        let b = f64::from(self.b) / 255.0;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let l = (max + min) / 2.0;
        let d = max - min;
        if d == 0.0 {
            return Hsla { h: 0.0, s: 0.0, l: l * 100.0, a: self.a };
        }
        let s = d / (1.0 - (2.0 * l - 1.0).abs());
        let mut h = if max == r {
            60.0 * (((g - b) / d) % 6.0)
        } else if max == g {
            60.0 * ((b - r) / d + 2.0)
        } else {
            60.0 * ((r - g) / d + 4.0)
        };
        if h < 0.0 {
            h += 360.0;
        }
        Hsla { h, s: s * 100.0, l: l * 100.0, a: self.a }
    }

    /// Linear interpolation between two colors in sRGB space, `t` clamped to `0.0..=1.0`.
    pub fn mix(&self, other: &Rgba, t: f64) -> Rgba {
        let t = t.clamp(0.0, 1.0);
        let lerp = |x: u8, y: u8| -> u8 {
            let v = f64::from(x) + (f64::from(y) - f64::from(x)) * t;
            v.round().clamp(0.0, 255.0) as u8
        };
        Rgba {
            r: lerp(self.r, other.r),
            g: lerp(self.g, other.g),
            b: lerp(self.b, other.b),
            a: self.a + (other.a - self.a) * t,
        }
    }
}

fn format_alpha(a: f64) -> String {
    let s = format!("{:.3}", a);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

impl fmt::Display for Rgba {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_css())
    }
}

impl Hsla {
    /// Builds an HSL color. The hue may be any finite number of degrees and wraps around
    /// (`-120` is `240`, `480` is `120`); saturation and lightness are clamped to `0..=100`.
    pub fn new(h: f64, s: f64, l: f64, a: f64) -> Hsla {
        Hsla {
            h: h % 360.0,
            s: s.clamp(0.0, 100.0),
            l: l.clamp(0.0, 100.0),
            a: clamp_alpha(a),
        }
    }

    /// Converts to sRGB, rounding each channel to nearest.
    pub fn to_rgba(&self) -> Rgba {
        let h = self.h % 360.0;
        let s = self.s.clamp(0.0, 100.0) / 100.0;
        let l = self.l.clamp(0.0, 100.0) / 100.0;
        let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
        let hp = h / 60.0;
        let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
        let (r1, g1, b1) = match hp as u32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = l - c / 2.0;
        Rgba {
            r: unit_to_byte(r1 + m),
            g: unit_to_byte(g1 + m),
            b: unit_to_byte(b1 + m),
            a: clamp_alpha(self.a),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_opaque() {
        assert_eq!(Rgba::rgb(255, 0, 128).to_hex(), "#ff0080");
    }

    #[test]
    fn css_forms() {
        assert_eq!(Rgba::rgb(1, 2, 3).to_css(), "rgb(1, 2, 3)");
        assert_eq!(Rgba::rgba(1, 2, 3, 0.25).to_css(), "rgba(1, 2, 3, 0.25)");
        assert_eq!(Rgba::rgba(1, 2, 3, 0.0).to_css(), "rgba(1, 2, 3, 0)");
    }

    #[test]
    fn hsl_primaries() {
        assert_eq!(Hsla::new(0.0, 100.0, 50.0, 1.0).to_rgba(), Rgba::rgb(255, 0, 0));
        assert_eq!(Hsla::new(120.0, 100.0, 50.0, 1.0).to_rgba(), Rgba::rgb(0, 255, 0));
        assert_eq!(Hsla::new(240.0, 100.0, 50.0, 1.0).to_rgba(), Rgba::rgb(0, 0, 255));
    }

    #[test]
    fn achromatic() {
        let h = Rgba::rgb(128, 128, 128).to_hsla();
        assert_eq!(h.h, 0.0);
        assert_eq!(h.s, 0.0);
    }

    #[test]
    fn mix_halfway() {
        assert_eq!(Rgba::rgb(0, 0, 0).mix(&Rgba::rgb(255, 255, 255), 0.5), Rgba::rgb(128, 128, 128));
    }

    #[test]
    fn alpha_clamped() {
        assert_eq!(Rgba::rgba(0, 0, 0, 3.0).a, 1.0);
        assert_eq!(Rgba::rgba(0, 0, 0, -1.0).a, 0.0);
    }
}
