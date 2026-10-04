//! Every named color (generated from the named-color table).

use chroma::{named, parse, Rgba};

#[test]
fn named_aliceblue() {
    let c = parse("aliceblue").unwrap();
    assert_eq!(c, Rgba::rgb(240, 248, 255));
    assert_eq!(c.to_hex(), "#f0f8ff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of aliceblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_antiquewhite() {
    let c = parse("antiquewhite").unwrap();
    assert_eq!(c, Rgba::rgb(250, 235, 215));
    assert_eq!(c.to_hex(), "#faebd7");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of antiquewhite");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_aqua() {
    let c = parse("aqua").unwrap();
    assert_eq!(c, Rgba::rgb(0, 255, 255));
    assert_eq!(c.to_hex(), "#00ffff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of aqua");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_aquamarine() {
    let c = parse("aquamarine").unwrap();
    assert_eq!(c, Rgba::rgb(127, 255, 212));
    assert_eq!(c.to_hex(), "#7fffd4");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of aquamarine");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_azure() {
    let c = parse("azure").unwrap();
    assert_eq!(c, Rgba::rgb(240, 255, 255));
    assert_eq!(c.to_hex(), "#f0ffff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of azure");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_beige() {
    let c = parse("beige").unwrap();
    assert_eq!(c, Rgba::rgb(245, 245, 220));
    assert_eq!(c.to_hex(), "#f5f5dc");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of beige");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_bisque() {
    let c = parse("bisque").unwrap();
    assert_eq!(c, Rgba::rgb(255, 228, 196));
    assert_eq!(c.to_hex(), "#ffe4c4");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of bisque");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_black() {
    let c = parse("black").unwrap();
    assert_eq!(c, Rgba::rgb(0, 0, 0));
    assert_eq!(c.to_hex(), "#000000");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of black");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_blanchedalmond() {
    let c = parse("blanchedalmond").unwrap();
    assert_eq!(c, Rgba::rgb(255, 235, 205));
    assert_eq!(c.to_hex(), "#ffebcd");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of blanchedalmond");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_blue() {
    let c = parse("blue").unwrap();
    assert_eq!(c, Rgba::rgb(0, 0, 255));
    assert_eq!(c.to_hex(), "#0000ff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of blue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_blueviolet() {
    let c = parse("blueviolet").unwrap();
    assert_eq!(c, Rgba::rgb(138, 43, 226));
    assert_eq!(c.to_hex(), "#8a2be2");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of blueviolet");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_brown() {
    let c = parse("brown").unwrap();
    assert_eq!(c, Rgba::rgb(165, 42, 42));
    assert_eq!(c.to_hex(), "#a52a2a");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of brown");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_burlywood() {
    let c = parse("burlywood").unwrap();
    assert_eq!(c, Rgba::rgb(222, 184, 135));
    assert_eq!(c.to_hex(), "#deb887");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of burlywood");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_cadetblue() {
    let c = parse("cadetblue").unwrap();
    assert_eq!(c, Rgba::rgb(95, 158, 160));
    assert_eq!(c.to_hex(), "#5f9ea0");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of cadetblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_chartreuse() {
    let c = parse("chartreuse").unwrap();
    assert_eq!(c, Rgba::rgb(127, 255, 0));
    assert_eq!(c.to_hex(), "#7fff00");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of chartreuse");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_chocolate() {
    let c = parse("chocolate").unwrap();
    assert_eq!(c, Rgba::rgb(210, 105, 30));
    assert_eq!(c.to_hex(), "#d2691e");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of chocolate");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_coral() {
    let c = parse("coral").unwrap();
    assert_eq!(c, Rgba::rgb(255, 127, 80));
    assert_eq!(c.to_hex(), "#ff7f50");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of coral");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_cornflowerblue() {
    let c = parse("cornflowerblue").unwrap();
    assert_eq!(c, Rgba::rgb(100, 149, 237));
    assert_eq!(c.to_hex(), "#6495ed");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of cornflowerblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_cornsilk() {
    let c = parse("cornsilk").unwrap();
    assert_eq!(c, Rgba::rgb(255, 248, 220));
    assert_eq!(c.to_hex(), "#fff8dc");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of cornsilk");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_crimson() {
    let c = parse("crimson").unwrap();
    assert_eq!(c, Rgba::rgb(220, 20, 60));
    assert_eq!(c.to_hex(), "#dc143c");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of crimson");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_cyan() {
    let c = parse("cyan").unwrap();
    assert_eq!(c, Rgba::rgb(0, 255, 255));
    assert_eq!(c.to_hex(), "#00ffff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of cyan");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkblue() {
    let c = parse("darkblue").unwrap();
    assert_eq!(c, Rgba::rgb(0, 0, 139));
    assert_eq!(c.to_hex(), "#00008b");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkcyan() {
    let c = parse("darkcyan").unwrap();
    assert_eq!(c, Rgba::rgb(0, 139, 139));
    assert_eq!(c.to_hex(), "#008b8b");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkcyan");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkgoldenrod() {
    let c = parse("darkgoldenrod").unwrap();
    assert_eq!(c, Rgba::rgb(184, 134, 11));
    assert_eq!(c.to_hex(), "#b8860b");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkgoldenrod");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkgray() {
    let c = parse("darkgray").unwrap();
    assert_eq!(c, Rgba::rgb(169, 169, 169));
    assert_eq!(c.to_hex(), "#a9a9a9");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkgray");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkgreen() {
    let c = parse("darkgreen").unwrap();
    assert_eq!(c, Rgba::rgb(0, 100, 0));
    assert_eq!(c.to_hex(), "#006400");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkgreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkgrey() {
    let c = parse("darkgrey").unwrap();
    assert_eq!(c, Rgba::rgb(169, 169, 169));
    assert_eq!(c.to_hex(), "#a9a9a9");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkgrey");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkkhaki() {
    let c = parse("darkkhaki").unwrap();
    assert_eq!(c, Rgba::rgb(189, 183, 107));
    assert_eq!(c.to_hex(), "#bdb76b");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkkhaki");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkmagenta() {
    let c = parse("darkmagenta").unwrap();
    assert_eq!(c, Rgba::rgb(139, 0, 139));
    assert_eq!(c.to_hex(), "#8b008b");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkmagenta");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkolivegreen() {
    let c = parse("darkolivegreen").unwrap();
    assert_eq!(c, Rgba::rgb(85, 107, 47));
    assert_eq!(c.to_hex(), "#556b2f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkolivegreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkorange() {
    let c = parse("darkorange").unwrap();
    assert_eq!(c, Rgba::rgb(255, 140, 0));
    assert_eq!(c.to_hex(), "#ff8c00");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkorange");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkorchid() {
    let c = parse("darkorchid").unwrap();
    assert_eq!(c, Rgba::rgb(153, 50, 204));
    assert_eq!(c.to_hex(), "#9932cc");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkorchid");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkred() {
    let c = parse("darkred").unwrap();
    assert_eq!(c, Rgba::rgb(139, 0, 0));
    assert_eq!(c.to_hex(), "#8b0000");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkred");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darksalmon() {
    let c = parse("darksalmon").unwrap();
    assert_eq!(c, Rgba::rgb(233, 150, 122));
    assert_eq!(c.to_hex(), "#e9967a");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darksalmon");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkseagreen() {
    let c = parse("darkseagreen").unwrap();
    assert_eq!(c, Rgba::rgb(143, 188, 143));
    assert_eq!(c.to_hex(), "#8fbc8f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkseagreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkslateblue() {
    let c = parse("darkslateblue").unwrap();
    assert_eq!(c, Rgba::rgb(72, 61, 139));
    assert_eq!(c.to_hex(), "#483d8b");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkslateblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkslategray() {
    let c = parse("darkslategray").unwrap();
    assert_eq!(c, Rgba::rgb(47, 79, 79));
    assert_eq!(c.to_hex(), "#2f4f4f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkslategray");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkslategrey() {
    let c = parse("darkslategrey").unwrap();
    assert_eq!(c, Rgba::rgb(47, 79, 79));
    assert_eq!(c.to_hex(), "#2f4f4f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkslategrey");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkturquoise() {
    let c = parse("darkturquoise").unwrap();
    assert_eq!(c, Rgba::rgb(0, 206, 209));
    assert_eq!(c.to_hex(), "#00ced1");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkturquoise");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_darkviolet() {
    let c = parse("darkviolet").unwrap();
    assert_eq!(c, Rgba::rgb(148, 0, 211));
    assert_eq!(c.to_hex(), "#9400d3");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of darkviolet");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_deeppink() {
    let c = parse("deeppink").unwrap();
    assert_eq!(c, Rgba::rgb(255, 20, 147));
    assert_eq!(c.to_hex(), "#ff1493");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of deeppink");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_deepskyblue() {
    let c = parse("deepskyblue").unwrap();
    assert_eq!(c, Rgba::rgb(0, 191, 255));
    assert_eq!(c.to_hex(), "#00bfff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of deepskyblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_dimgray() {
    let c = parse("dimgray").unwrap();
    assert_eq!(c, Rgba::rgb(105, 105, 105));
    assert_eq!(c.to_hex(), "#696969");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of dimgray");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_dimgrey() {
    let c = parse("dimgrey").unwrap();
    assert_eq!(c, Rgba::rgb(105, 105, 105));
    assert_eq!(c.to_hex(), "#696969");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of dimgrey");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_dodgerblue() {
    let c = parse("dodgerblue").unwrap();
    assert_eq!(c, Rgba::rgb(30, 144, 255));
    assert_eq!(c.to_hex(), "#1e90ff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of dodgerblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_firebrick() {
    let c = parse("firebrick").unwrap();
    assert_eq!(c, Rgba::rgb(178, 34, 34));
    assert_eq!(c.to_hex(), "#b22222");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of firebrick");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_floralwhite() {
    let c = parse("floralwhite").unwrap();
    assert_eq!(c, Rgba::rgb(255, 250, 240));
    assert_eq!(c.to_hex(), "#fffaf0");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of floralwhite");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_forestgreen() {
    let c = parse("forestgreen").unwrap();
    assert_eq!(c, Rgba::rgb(34, 139, 34));
    assert_eq!(c.to_hex(), "#228b22");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of forestgreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_fuchsia() {
    let c = parse("fuchsia").unwrap();
    assert_eq!(c, Rgba::rgb(255, 0, 255));
    assert_eq!(c.to_hex(), "#ff00ff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of fuchsia");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_gainsboro() {
    let c = parse("gainsboro").unwrap();
    assert_eq!(c, Rgba::rgb(220, 220, 220));
    assert_eq!(c.to_hex(), "#dcdcdc");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of gainsboro");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_ghostwhite() {
    let c = parse("ghostwhite").unwrap();
    assert_eq!(c, Rgba::rgb(248, 248, 255));
    assert_eq!(c.to_hex(), "#f8f8ff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of ghostwhite");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_gold() {
    let c = parse("gold").unwrap();
    assert_eq!(c, Rgba::rgb(255, 215, 0));
    assert_eq!(c.to_hex(), "#ffd700");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of gold");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_goldenrod() {
    let c = parse("goldenrod").unwrap();
    assert_eq!(c, Rgba::rgb(218, 165, 32));
    assert_eq!(c.to_hex(), "#daa520");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of goldenrod");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_gray() {
    let c = parse("gray").unwrap();
    assert_eq!(c, Rgba::rgb(128, 128, 128));
    assert_eq!(c.to_hex(), "#808080");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of gray");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_green() {
    let c = parse("green").unwrap();
    assert_eq!(c, Rgba::rgb(0, 128, 0));
    assert_eq!(c.to_hex(), "#008000");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of green");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_greenyellow() {
    let c = parse("greenyellow").unwrap();
    assert_eq!(c, Rgba::rgb(173, 255, 47));
    assert_eq!(c.to_hex(), "#adff2f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of greenyellow");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_grey() {
    let c = parse("grey").unwrap();
    assert_eq!(c, Rgba::rgb(128, 128, 128));
    assert_eq!(c.to_hex(), "#808080");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of grey");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_honeydew() {
    let c = parse("honeydew").unwrap();
    assert_eq!(c, Rgba::rgb(240, 255, 240));
    assert_eq!(c.to_hex(), "#f0fff0");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of honeydew");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_hotpink() {
    let c = parse("hotpink").unwrap();
    assert_eq!(c, Rgba::rgb(255, 105, 180));
    assert_eq!(c.to_hex(), "#ff69b4");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of hotpink");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_indianred() {
    let c = parse("indianred").unwrap();
    assert_eq!(c, Rgba::rgb(205, 92, 92));
    assert_eq!(c.to_hex(), "#cd5c5c");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of indianred");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_indigo() {
    let c = parse("indigo").unwrap();
    assert_eq!(c, Rgba::rgb(75, 0, 130));
    assert_eq!(c.to_hex(), "#4b0082");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of indigo");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_ivory() {
    let c = parse("ivory").unwrap();
    assert_eq!(c, Rgba::rgb(255, 255, 240));
    assert_eq!(c.to_hex(), "#fffff0");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of ivory");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_khaki() {
    let c = parse("khaki").unwrap();
    assert_eq!(c, Rgba::rgb(240, 230, 140));
    assert_eq!(c.to_hex(), "#f0e68c");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of khaki");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lavender() {
    let c = parse("lavender").unwrap();
    assert_eq!(c, Rgba::rgb(230, 230, 250));
    assert_eq!(c.to_hex(), "#e6e6fa");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lavender");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lavenderblush() {
    let c = parse("lavenderblush").unwrap();
    assert_eq!(c, Rgba::rgb(255, 240, 245));
    assert_eq!(c.to_hex(), "#fff0f5");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lavenderblush");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lawngreen() {
    let c = parse("lawngreen").unwrap();
    assert_eq!(c, Rgba::rgb(124, 252, 0));
    assert_eq!(c.to_hex(), "#7cfc00");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lawngreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lemonchiffon() {
    let c = parse("lemonchiffon").unwrap();
    assert_eq!(c, Rgba::rgb(255, 250, 205));
    assert_eq!(c.to_hex(), "#fffacd");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lemonchiffon");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightblue() {
    let c = parse("lightblue").unwrap();
    assert_eq!(c, Rgba::rgb(173, 216, 230));
    assert_eq!(c.to_hex(), "#add8e6");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightcoral() {
    let c = parse("lightcoral").unwrap();
    assert_eq!(c, Rgba::rgb(240, 128, 128));
    assert_eq!(c.to_hex(), "#f08080");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightcoral");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightcyan() {
    let c = parse("lightcyan").unwrap();
    assert_eq!(c, Rgba::rgb(224, 255, 255));
    assert_eq!(c.to_hex(), "#e0ffff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightcyan");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightgoldenrodyellow() {
    let c = parse("lightgoldenrodyellow").unwrap();
    assert_eq!(c, Rgba::rgb(250, 250, 210));
    assert_eq!(c.to_hex(), "#fafad2");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightgoldenrodyellow");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightgray() {
    let c = parse("lightgray").unwrap();
    assert_eq!(c, Rgba::rgb(211, 211, 211));
    assert_eq!(c.to_hex(), "#d3d3d3");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightgray");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightgreen() {
    let c = parse("lightgreen").unwrap();
    assert_eq!(c, Rgba::rgb(144, 238, 144));
    assert_eq!(c.to_hex(), "#90ee90");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightgreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightgrey() {
    let c = parse("lightgrey").unwrap();
    assert_eq!(c, Rgba::rgb(211, 211, 211));
    assert_eq!(c.to_hex(), "#d3d3d3");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightgrey");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightpink() {
    let c = parse("lightpink").unwrap();
    assert_eq!(c, Rgba::rgb(255, 182, 193));
    assert_eq!(c.to_hex(), "#ffb6c1");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightpink");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightsalmon() {
    let c = parse("lightsalmon").unwrap();
    assert_eq!(c, Rgba::rgb(255, 160, 122));
    assert_eq!(c.to_hex(), "#ffa07a");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightsalmon");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightseagreen() {
    let c = parse("lightseagreen").unwrap();
    assert_eq!(c, Rgba::rgb(32, 178, 170));
    assert_eq!(c.to_hex(), "#20b2aa");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightseagreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightskyblue() {
    let c = parse("lightskyblue").unwrap();
    assert_eq!(c, Rgba::rgb(135, 206, 250));
    assert_eq!(c.to_hex(), "#87cefa");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightskyblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightslategray() {
    let c = parse("lightslategray").unwrap();
    assert_eq!(c, Rgba::rgb(119, 136, 153));
    assert_eq!(c.to_hex(), "#778899");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightslategray");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightslategrey() {
    let c = parse("lightslategrey").unwrap();
    assert_eq!(c, Rgba::rgb(119, 136, 153));
    assert_eq!(c.to_hex(), "#778899");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightslategrey");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightsteelblue() {
    let c = parse("lightsteelblue").unwrap();
    assert_eq!(c, Rgba::rgb(176, 196, 222));
    assert_eq!(c.to_hex(), "#b0c4de");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightsteelblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lightyellow() {
    let c = parse("lightyellow").unwrap();
    assert_eq!(c, Rgba::rgb(255, 255, 224));
    assert_eq!(c.to_hex(), "#ffffe0");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lightyellow");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_lime() {
    let c = parse("lime").unwrap();
    assert_eq!(c, Rgba::rgb(0, 255, 0));
    assert_eq!(c.to_hex(), "#00ff00");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of lime");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_limegreen() {
    let c = parse("limegreen").unwrap();
    assert_eq!(c, Rgba::rgb(50, 205, 50));
    assert_eq!(c.to_hex(), "#32cd32");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of limegreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_linen() {
    let c = parse("linen").unwrap();
    assert_eq!(c, Rgba::rgb(250, 240, 230));
    assert_eq!(c.to_hex(), "#faf0e6");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of linen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_magenta() {
    let c = parse("magenta").unwrap();
    assert_eq!(c, Rgba::rgb(255, 0, 255));
    assert_eq!(c.to_hex(), "#ff00ff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of magenta");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_maroon() {
    let c = parse("maroon").unwrap();
    assert_eq!(c, Rgba::rgb(128, 0, 0));
    assert_eq!(c.to_hex(), "#800000");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of maroon");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumaquamarine() {
    let c = parse("mediumaquamarine").unwrap();
    assert_eq!(c, Rgba::rgb(102, 205, 170));
    assert_eq!(c.to_hex(), "#66cdaa");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumaquamarine");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumblue() {
    let c = parse("mediumblue").unwrap();
    assert_eq!(c, Rgba::rgb(0, 0, 205));
    assert_eq!(c.to_hex(), "#0000cd");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumorchid() {
    let c = parse("mediumorchid").unwrap();
    assert_eq!(c, Rgba::rgb(186, 85, 211));
    assert_eq!(c.to_hex(), "#ba55d3");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumorchid");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumpurple() {
    let c = parse("mediumpurple").unwrap();
    assert_eq!(c, Rgba::rgb(147, 112, 219));
    assert_eq!(c.to_hex(), "#9370db");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumpurple");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumseagreen() {
    let c = parse("mediumseagreen").unwrap();
    assert_eq!(c, Rgba::rgb(60, 179, 113));
    assert_eq!(c.to_hex(), "#3cb371");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumseagreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumslateblue() {
    let c = parse("mediumslateblue").unwrap();
    assert_eq!(c, Rgba::rgb(123, 104, 238));
    assert_eq!(c.to_hex(), "#7b68ee");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumslateblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumspringgreen() {
    let c = parse("mediumspringgreen").unwrap();
    assert_eq!(c, Rgba::rgb(0, 250, 154));
    assert_eq!(c.to_hex(), "#00fa9a");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumspringgreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumturquoise() {
    let c = parse("mediumturquoise").unwrap();
    assert_eq!(c, Rgba::rgb(72, 209, 204));
    assert_eq!(c.to_hex(), "#48d1cc");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumturquoise");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mediumvioletred() {
    let c = parse("mediumvioletred").unwrap();
    assert_eq!(c, Rgba::rgb(199, 21, 133));
    assert_eq!(c.to_hex(), "#c71585");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mediumvioletred");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_midnightblue() {
    let c = parse("midnightblue").unwrap();
    assert_eq!(c, Rgba::rgb(25, 25, 112));
    assert_eq!(c.to_hex(), "#191970");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of midnightblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mintcream() {
    let c = parse("mintcream").unwrap();
    assert_eq!(c, Rgba::rgb(245, 255, 250));
    assert_eq!(c.to_hex(), "#f5fffa");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mintcream");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_mistyrose() {
    let c = parse("mistyrose").unwrap();
    assert_eq!(c, Rgba::rgb(255, 228, 225));
    assert_eq!(c.to_hex(), "#ffe4e1");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of mistyrose");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_moccasin() {
    let c = parse("moccasin").unwrap();
    assert_eq!(c, Rgba::rgb(255, 228, 181));
    assert_eq!(c.to_hex(), "#ffe4b5");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of moccasin");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_navajowhite() {
    let c = parse("navajowhite").unwrap();
    assert_eq!(c, Rgba::rgb(255, 222, 173));
    assert_eq!(c.to_hex(), "#ffdead");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of navajowhite");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_navy() {
    let c = parse("navy").unwrap();
    assert_eq!(c, Rgba::rgb(0, 0, 128));
    assert_eq!(c.to_hex(), "#000080");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of navy");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_oldlace() {
    let c = parse("oldlace").unwrap();
    assert_eq!(c, Rgba::rgb(253, 245, 230));
    assert_eq!(c.to_hex(), "#fdf5e6");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of oldlace");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_olive() {
    let c = parse("olive").unwrap();
    assert_eq!(c, Rgba::rgb(128, 128, 0));
    assert_eq!(c.to_hex(), "#808000");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of olive");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_olivedrab() {
    let c = parse("olivedrab").unwrap();
    assert_eq!(c, Rgba::rgb(107, 142, 35));
    assert_eq!(c.to_hex(), "#6b8e23");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of olivedrab");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_orange() {
    let c = parse("orange").unwrap();
    assert_eq!(c, Rgba::rgb(255, 165, 0));
    assert_eq!(c.to_hex(), "#ffa500");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of orange");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_orangered() {
    let c = parse("orangered").unwrap();
    assert_eq!(c, Rgba::rgb(255, 69, 0));
    assert_eq!(c.to_hex(), "#ff4500");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of orangered");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_orchid() {
    let c = parse("orchid").unwrap();
    assert_eq!(c, Rgba::rgb(218, 112, 214));
    assert_eq!(c.to_hex(), "#da70d6");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of orchid");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_palegoldenrod() {
    let c = parse("palegoldenrod").unwrap();
    assert_eq!(c, Rgba::rgb(238, 232, 170));
    assert_eq!(c.to_hex(), "#eee8aa");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of palegoldenrod");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_palegreen() {
    let c = parse("palegreen").unwrap();
    assert_eq!(c, Rgba::rgb(152, 251, 152));
    assert_eq!(c.to_hex(), "#98fb98");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of palegreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_paleturquoise() {
    let c = parse("paleturquoise").unwrap();
    assert_eq!(c, Rgba::rgb(175, 238, 238));
    assert_eq!(c.to_hex(), "#afeeee");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of paleturquoise");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_palevioletred() {
    let c = parse("palevioletred").unwrap();
    assert_eq!(c, Rgba::rgb(219, 112, 147));
    assert_eq!(c.to_hex(), "#db7093");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of palevioletred");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_papayawhip() {
    let c = parse("papayawhip").unwrap();
    assert_eq!(c, Rgba::rgb(255, 239, 213));
    assert_eq!(c.to_hex(), "#ffefd5");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of papayawhip");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_peachpuff() {
    let c = parse("peachpuff").unwrap();
    assert_eq!(c, Rgba::rgb(255, 218, 185));
    assert_eq!(c.to_hex(), "#ffdab9");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of peachpuff");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_peru() {
    let c = parse("peru").unwrap();
    assert_eq!(c, Rgba::rgb(205, 133, 63));
    assert_eq!(c.to_hex(), "#cd853f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of peru");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_pink() {
    let c = parse("pink").unwrap();
    assert_eq!(c, Rgba::rgb(255, 192, 203));
    assert_eq!(c.to_hex(), "#ffc0cb");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of pink");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_plum() {
    let c = parse("plum").unwrap();
    assert_eq!(c, Rgba::rgb(221, 160, 221));
    assert_eq!(c.to_hex(), "#dda0dd");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of plum");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_powderblue() {
    let c = parse("powderblue").unwrap();
    assert_eq!(c, Rgba::rgb(176, 224, 230));
    assert_eq!(c.to_hex(), "#b0e0e6");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of powderblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_purple() {
    let c = parse("purple").unwrap();
    assert_eq!(c, Rgba::rgb(128, 0, 128));
    assert_eq!(c.to_hex(), "#800080");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of purple");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_rebeccapurple() {
    let c = parse("rebeccapurple").unwrap();
    assert_eq!(c, Rgba::rgb(102, 51, 153));
    assert_eq!(c.to_hex(), "#663399");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of rebeccapurple");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_red() {
    let c = parse("red").unwrap();
    assert_eq!(c, Rgba::rgb(255, 0, 0));
    assert_eq!(c.to_hex(), "#ff0000");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of red");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_rosybrown() {
    let c = parse("rosybrown").unwrap();
    assert_eq!(c, Rgba::rgb(188, 143, 143));
    assert_eq!(c.to_hex(), "#bc8f8f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of rosybrown");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_royalblue() {
    let c = parse("royalblue").unwrap();
    assert_eq!(c, Rgba::rgb(65, 105, 225));
    assert_eq!(c.to_hex(), "#4169e1");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of royalblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_saddlebrown() {
    let c = parse("saddlebrown").unwrap();
    assert_eq!(c, Rgba::rgb(139, 69, 19));
    assert_eq!(c.to_hex(), "#8b4513");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of saddlebrown");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_salmon() {
    let c = parse("salmon").unwrap();
    assert_eq!(c, Rgba::rgb(250, 128, 114));
    assert_eq!(c.to_hex(), "#fa8072");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of salmon");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_sandybrown() {
    let c = parse("sandybrown").unwrap();
    assert_eq!(c, Rgba::rgb(244, 164, 96));
    assert_eq!(c.to_hex(), "#f4a460");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of sandybrown");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_seagreen() {
    let c = parse("seagreen").unwrap();
    assert_eq!(c, Rgba::rgb(46, 139, 87));
    assert_eq!(c.to_hex(), "#2e8b57");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of seagreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_seashell() {
    let c = parse("seashell").unwrap();
    assert_eq!(c, Rgba::rgb(255, 245, 238));
    assert_eq!(c.to_hex(), "#fff5ee");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of seashell");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_sienna() {
    let c = parse("sienna").unwrap();
    assert_eq!(c, Rgba::rgb(160, 82, 45));
    assert_eq!(c.to_hex(), "#a0522d");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of sienna");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_silver() {
    let c = parse("silver").unwrap();
    assert_eq!(c, Rgba::rgb(192, 192, 192));
    assert_eq!(c.to_hex(), "#c0c0c0");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of silver");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_skyblue() {
    let c = parse("skyblue").unwrap();
    assert_eq!(c, Rgba::rgb(135, 206, 235));
    assert_eq!(c.to_hex(), "#87ceeb");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of skyblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_slateblue() {
    let c = parse("slateblue").unwrap();
    assert_eq!(c, Rgba::rgb(106, 90, 205));
    assert_eq!(c.to_hex(), "#6a5acd");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of slateblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_slategray() {
    let c = parse("slategray").unwrap();
    assert_eq!(c, Rgba::rgb(112, 128, 144));
    assert_eq!(c.to_hex(), "#708090");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of slategray");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_slategrey() {
    let c = parse("slategrey").unwrap();
    assert_eq!(c, Rgba::rgb(112, 128, 144));
    assert_eq!(c.to_hex(), "#708090");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of slategrey");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_snow() {
    let c = parse("snow").unwrap();
    assert_eq!(c, Rgba::rgb(255, 250, 250));
    assert_eq!(c.to_hex(), "#fffafa");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of snow");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_springgreen() {
    let c = parse("springgreen").unwrap();
    assert_eq!(c, Rgba::rgb(0, 255, 127));
    assert_eq!(c.to_hex(), "#00ff7f");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of springgreen");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_steelblue() {
    let c = parse("steelblue").unwrap();
    assert_eq!(c, Rgba::rgb(70, 130, 180));
    assert_eq!(c.to_hex(), "#4682b4");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of steelblue");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_tan() {
    let c = parse("tan").unwrap();
    assert_eq!(c, Rgba::rgb(210, 180, 140));
    assert_eq!(c.to_hex(), "#d2b48c");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of tan");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_teal() {
    let c = parse("teal").unwrap();
    assert_eq!(c, Rgba::rgb(0, 128, 128));
    assert_eq!(c.to_hex(), "#008080");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of teal");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_thistle() {
    let c = parse("thistle").unwrap();
    assert_eq!(c, Rgba::rgb(216, 191, 216));
    assert_eq!(c.to_hex(), "#d8bfd8");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of thistle");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_tomato() {
    let c = parse("tomato").unwrap();
    assert_eq!(c, Rgba::rgb(255, 99, 71));
    assert_eq!(c.to_hex(), "#ff6347");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of tomato");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_turquoise() {
    let c = parse("turquoise").unwrap();
    assert_eq!(c, Rgba::rgb(64, 224, 208));
    assert_eq!(c.to_hex(), "#40e0d0");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of turquoise");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_violet() {
    let c = parse("violet").unwrap();
    assert_eq!(c, Rgba::rgb(238, 130, 238));
    assert_eq!(c.to_hex(), "#ee82ee");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of violet");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_wheat() {
    let c = parse("wheat").unwrap();
    assert_eq!(c, Rgba::rgb(245, 222, 179));
    assert_eq!(c.to_hex(), "#f5deb3");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of wheat");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_white() {
    let c = parse("white").unwrap();
    assert_eq!(c, Rgba::rgb(255, 255, 255));
    assert_eq!(c.to_hex(), "#ffffff");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of white");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_whitesmoke() {
    let c = parse("whitesmoke").unwrap();
    assert_eq!(c, Rgba::rgb(245, 245, 245));
    assert_eq!(c.to_hex(), "#f5f5f5");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of whitesmoke");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_yellow() {
    let c = parse("yellow").unwrap();
    assert_eq!(c, Rgba::rgb(255, 255, 0));
    assert_eq!(c.to_hex(), "#ffff00");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of yellow");
    assert!(named::name_of(&c).is_some());
}

#[test]
fn named_yellowgreen() {
    let c = parse("yellowgreen").unwrap();
    assert_eq!(c, Rgba::rgb(154, 205, 50));
    assert_eq!(c.to_hex(), "#9acd32");
    assert_eq!(c.to_hsla().to_rgba(), c, "HSL round trip of yellowgreen");
    assert!(named::name_of(&c).is_some());
}
