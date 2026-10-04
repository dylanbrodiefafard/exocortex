//! WCAG 2.x relative luminance and contrast ratio.

use crate::color::Rgba;

/// Conformance level reached by a contrast ratio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Fail,
    AA,
    AAA,
}

fn linear(channel: u8) -> f64 {
    let c = f64::from(channel) / 255.0;
    if c <= 0.03928 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// WCAG relative luminance in `0.0..=1.0`. Alpha is ignored.
pub fn relative_luminance(c: &Rgba) -> f64 {
    0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}

/// Contrast ratio between two colors, `1.0..=21.0`, independent of argument order.
pub fn ratio(a: &Rgba, b: &Rgba) -> f64 {
    let la = relative_luminance(a);
    let lb = relative_luminance(b);
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// The level a ratio reaches: normal text needs 4.5 (AA) / 7 (AAA), large text 3 / 4.5.
pub fn level(ratio: f64, large_text: bool) -> Level {
    let (aa, aaa) = if large_text { (3.0, 4.5) } else { (4.5, 7.0) };
    if ratio >= aaa {
        Level::AAA
    } else if ratio >= aa {
        Level::AA
    } else {
        Level::Fail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn black_on_white() {
        let r = ratio(&Rgba::rgb(0, 0, 0), &Rgba::rgb(255, 255, 255));
        assert!((r - 21.0).abs() < 1e-9);
        assert_eq!(level(r, false), Level::AAA);
    }

    #[test]
    fn symmetric() {
        let a = Rgba::rgb(10, 200, 30);
        let b = Rgba::rgb(90, 10, 140);
        assert_eq!(ratio(&a, &b), ratio(&b, &a));
    }
}
