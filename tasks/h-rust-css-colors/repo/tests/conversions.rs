use chroma::contrast::{self, Level};
use chroma::{parse, Hsla, Rgba};

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn hex_short_with_alpha() {
    assert_eq!(parse("#f008").unwrap(), Rgba::rgba(255, 0, 0, 136.0 / 255.0));
}

#[test]
fn hex_long_with_alpha() {
    let c = parse("#11223344").unwrap();
    assert_eq!((c.r, c.g, c.b), (0x11, 0x22, 0x33));
    assert!(close(c.a, 0x44 as f64 / 255.0));
}

#[test]
fn hex_alpha_round_trip() {
    for s in ["#00000000", "#12345678", "#abcdef01", "#fedcba99", "#ffffffee"] {
        assert_eq!(parse(s).unwrap().to_hex(), s);
    }
}

#[test]
fn opaque_hex_drops_alpha() {
    assert_eq!(parse("#123456ff").unwrap().to_hex(), "#123456");
}

#[test]
fn rgb_percentages() {
    assert_eq!(parse("rgb(100%, 50%, 0%)").unwrap(), Rgba::rgb(255, 128, 0));
    assert_eq!(parse("rgb(20%, 40%, 60%)").unwrap(), Rgba::rgb(51, 102, 153));
}

#[test]
fn rgba_alpha_forms() {
    assert_eq!(parse("rgba(1, 2, 3, 0.4)").unwrap(), Rgba::rgba(1, 2, 3, 0.4));
    assert_eq!(parse("rgba(1, 2, 3, 40%)").unwrap(), Rgba::rgba(1, 2, 3, 0.4));
    assert_eq!(parse("rgba(1, 2, 3, 7)").unwrap().a, 1.0);
    assert_eq!(parse("rgb(1, 2, 3, -1)").unwrap().a, 0.0);
}

#[test]
fn rgb_argument_count() {
    assert!(parse("rgb(1, 2)").is_err());
    assert!(parse("rgb(1, 2, 3, 4, 5)").is_err());
    assert!(parse("rgb(1, , 3)").is_err());
}

#[test]
fn hsl_basic() {
    assert_eq!(parse("hsl(0, 100%, 50%)").unwrap(), Rgba::rgb(255, 0, 0));
    assert_eq!(parse("hsl(120deg, 100%, 25%)").unwrap(), Rgba::rgb(0, 128, 0));
    assert_eq!(parse("hsl(270, 50%, 40%)").unwrap(), Rgba::rgb(102, 51, 153));
}

#[test]
fn hsl_alpha() {
    let c = parse("hsla(240, 100%, 50%, 0.5)").unwrap();
    assert_eq!((c.r, c.g, c.b), (0, 0, 255));
    assert!(close(c.a, 0.5));
}

#[test]
fn hsl_requires_percentages() {
    assert!(parse("hsl(120, 100, 50%)").is_err());
    assert!(parse("hsl(120, 100%, 50)").is_err());
    assert!(parse("hsl(abc, 100%, 50%)").is_err());
}

#[test]
fn hsl_clamps_saturation_and_lightness() {
    assert_eq!(parse("hsl(0, 150%, 50%)").unwrap(), Rgba::rgb(255, 0, 0));
    assert_eq!(parse("hsl(0, 100%, 120%)").unwrap(), Rgba::rgb(255, 255, 255));
    assert_eq!(parse("hsl(0, 100%, -3%)").unwrap(), Rgba::rgb(0, 0, 0));
}

#[test]
fn hsl_hue_above_360_wraps() {
    assert_eq!(parse("hsl(480, 100%, 50%)").unwrap(), Rgba::rgb(0, 255, 0));
    assert_eq!(parse("hsl(360, 100%, 50%)").unwrap(), Rgba::rgb(255, 0, 0));
}

#[test]
fn hsl_negative_hue_wraps() {
    assert_eq!(parse("hsl(-120, 100%, 50%)").unwrap(), Rgba::rgb(0, 0, 255));
    assert_eq!(parse("hsl(-30deg, 100%, 50%)").unwrap(), Rgba::rgb(255, 0, 128));
}

#[test]
fn to_hsla_values() {
    let h = Rgba::rgb(102, 51, 153).to_hsla();
    assert!(close(h.h, 270.0));
    assert!(close(h.s, 50.0));
    assert!(close(h.l, 40.0));
    let h = Rgba::rgb(255, 0, 128).to_hsla();
    assert!(close(h.h, 329.882352941), "{h:?}");
}

#[test]
fn hsla_new_normalizes() {
    let h = Hsla::new(720.0, 120.0, -5.0, 2.0);
    assert_eq!((h.h, h.s, h.l, h.a), (0.0, 100.0, 0.0, 1.0));
}

#[test]
fn css_output() {
    assert_eq!(parse("#0a0b0c").unwrap().to_css(), "rgb(10, 11, 12)");
    assert_eq!(Rgba::rgba(10, 11, 12, 0.3333).to_css(), "rgba(10, 11, 12, 0.333)");
    assert_eq!(Rgba::rgba(10, 11, 12, 0.5).to_string(), "rgba(10, 11, 12, 0.5)");
}

#[test]
fn hex_alpha_rounds_to_nearest() {
    assert_eq!(Rgba::rgba(255, 0, 0, 0.5).to_hex(), "#ff000080");
    assert_eq!(Rgba::rgba(0, 0, 0, 0.2).to_hex(), "#00000033");
}

#[test]
fn mix_endpoints() {
    let a = Rgba::rgb(10, 20, 30);
    let b = Rgba::rgba(200, 100, 0, 0.0);
    assert_eq!(a.mix(&b, 0.0), a);
    assert_eq!(a.mix(&b, 1.0), b);
    assert_eq!(a.mix(&b, 7.0), b);
}

#[test]
fn luminance_extremes() {
    assert!(close(contrast::relative_luminance(&Rgba::rgb(0, 0, 0)), 0.0));
    assert!(close(contrast::relative_luminance(&Rgba::rgb(255, 255, 255)), 1.0));
}

#[test]
fn contrast_known_pairs() {
    let r = contrast::ratio(&parse("#777").unwrap(), &parse("white").unwrap());
    assert!((r - 4.478).abs() < 0.001, "{r}");
    assert_eq!(contrast::level(r, false), Level::Fail);
    assert_eq!(contrast::level(r, true), Level::AA);
    let r = contrast::ratio(&parse("#595959").unwrap(), &parse("#fff").unwrap());
    assert_eq!(contrast::level(r, false), Level::AAA);
}

#[test]
fn contrast_levels_at_thresholds() {
    assert_eq!(contrast::level(4.5, false), Level::AA);
    assert_eq!(contrast::level(7.0, false), Level::AAA);
    assert_eq!(contrast::level(3.0, true), Level::AA);
    assert_eq!(contrast::level(2.99, true), Level::Fail);
}

#[test]
fn parse_error_message() {
    let e = parse("#12").unwrap_err();
    assert_eq!(e.to_string(), "invalid color \"#12\": hex color must have 3, 4, 6 or 8 digits");
}
