//! Alternative spellings of every named color (generated from the named-color table).

use chroma::{parse, Rgba};

#[test]
fn upper_aliceblue() {
    assert_eq!(parse("  ALICEBLUE ").unwrap(), Rgba::rgb(240, 248, 255));
}

#[test]
fn rgb_fn_aliceblue() {
    assert_eq!(parse("rgb(240, 248, 255)").unwrap(), Rgba::rgb(240, 248, 255));
    assert_eq!(parse("rgba(240,248,255,1)").unwrap().to_hex(), "#f0f8ff");
}

#[test]
fn hex_aliceblue() {
    assert_eq!(parse("#F0F8FF").unwrap().to_css(), "rgb(240, 248, 255)");
}

#[test]
fn upper_antiquewhite() {
    assert_eq!(parse("  ANTIQUEWHITE ").unwrap(), Rgba::rgb(250, 235, 215));
}

#[test]
fn rgb_fn_antiquewhite() {
    assert_eq!(parse("rgb(250, 235, 215)").unwrap(), Rgba::rgb(250, 235, 215));
    assert_eq!(parse("rgba(250,235,215,1)").unwrap().to_hex(), "#faebd7");
}

#[test]
fn hex_antiquewhite() {
    assert_eq!(parse("#FAEBD7").unwrap().to_css(), "rgb(250, 235, 215)");
}

#[test]
fn upper_aqua() {
    assert_eq!(parse("  AQUA ").unwrap(), Rgba::rgb(0, 255, 255));
}

#[test]
fn rgb_fn_aqua() {
    assert_eq!(parse("rgb(0, 255, 255)").unwrap(), Rgba::rgb(0, 255, 255));
    assert_eq!(parse("rgba(0,255,255,1)").unwrap().to_hex(), "#00ffff");
}

#[test]
fn hex_aqua() {
    assert_eq!(parse("#00FFFF").unwrap().to_css(), "rgb(0, 255, 255)");
}

#[test]
fn upper_aquamarine() {
    assert_eq!(parse("  AQUAMARINE ").unwrap(), Rgba::rgb(127, 255, 212));
}

#[test]
fn rgb_fn_aquamarine() {
    assert_eq!(parse("rgb(127, 255, 212)").unwrap(), Rgba::rgb(127, 255, 212));
    assert_eq!(parse("rgba(127,255,212,1)").unwrap().to_hex(), "#7fffd4");
}

#[test]
fn hex_aquamarine() {
    assert_eq!(parse("#7FFFD4").unwrap().to_css(), "rgb(127, 255, 212)");
}

#[test]
fn upper_azure() {
    assert_eq!(parse("  AZURE ").unwrap(), Rgba::rgb(240, 255, 255));
}

#[test]
fn rgb_fn_azure() {
    assert_eq!(parse("rgb(240, 255, 255)").unwrap(), Rgba::rgb(240, 255, 255));
    assert_eq!(parse("rgba(240,255,255,1)").unwrap().to_hex(), "#f0ffff");
}

#[test]
fn hex_azure() {
    assert_eq!(parse("#F0FFFF").unwrap().to_css(), "rgb(240, 255, 255)");
}

#[test]
fn upper_beige() {
    assert_eq!(parse("  BEIGE ").unwrap(), Rgba::rgb(245, 245, 220));
}

#[test]
fn rgb_fn_beige() {
    assert_eq!(parse("rgb(245, 245, 220)").unwrap(), Rgba::rgb(245, 245, 220));
    assert_eq!(parse("rgba(245,245,220,1)").unwrap().to_hex(), "#f5f5dc");
}

#[test]
fn hex_beige() {
    assert_eq!(parse("#F5F5DC").unwrap().to_css(), "rgb(245, 245, 220)");
}

#[test]
fn upper_bisque() {
    assert_eq!(parse("  BISQUE ").unwrap(), Rgba::rgb(255, 228, 196));
}

#[test]
fn rgb_fn_bisque() {
    assert_eq!(parse("rgb(255, 228, 196)").unwrap(), Rgba::rgb(255, 228, 196));
    assert_eq!(parse("rgba(255,228,196,1)").unwrap().to_hex(), "#ffe4c4");
}

#[test]
fn hex_bisque() {
    assert_eq!(parse("#FFE4C4").unwrap().to_css(), "rgb(255, 228, 196)");
}

#[test]
fn upper_black() {
    assert_eq!(parse("  BLACK ").unwrap(), Rgba::rgb(0, 0, 0));
}

#[test]
fn rgb_fn_black() {
    assert_eq!(parse("rgb(0, 0, 0)").unwrap(), Rgba::rgb(0, 0, 0));
    assert_eq!(parse("rgba(0,0,0,1)").unwrap().to_hex(), "#000000");
}

#[test]
fn hex_black() {
    assert_eq!(parse("#000000").unwrap().to_css(), "rgb(0, 0, 0)");
}

#[test]
fn upper_blanchedalmond() {
    assert_eq!(parse("  BLANCHEDALMOND ").unwrap(), Rgba::rgb(255, 235, 205));
}

#[test]
fn rgb_fn_blanchedalmond() {
    assert_eq!(parse("rgb(255, 235, 205)").unwrap(), Rgba::rgb(255, 235, 205));
    assert_eq!(parse("rgba(255,235,205,1)").unwrap().to_hex(), "#ffebcd");
}

#[test]
fn hex_blanchedalmond() {
    assert_eq!(parse("#FFEBCD").unwrap().to_css(), "rgb(255, 235, 205)");
}

#[test]
fn upper_blue() {
    assert_eq!(parse("  BLUE ").unwrap(), Rgba::rgb(0, 0, 255));
}

#[test]
fn rgb_fn_blue() {
    assert_eq!(parse("rgb(0, 0, 255)").unwrap(), Rgba::rgb(0, 0, 255));
    assert_eq!(parse("rgba(0,0,255,1)").unwrap().to_hex(), "#0000ff");
}

#[test]
fn hex_blue() {
    assert_eq!(parse("#0000FF").unwrap().to_css(), "rgb(0, 0, 255)");
}

#[test]
fn upper_blueviolet() {
    assert_eq!(parse("  BLUEVIOLET ").unwrap(), Rgba::rgb(138, 43, 226));
}

#[test]
fn rgb_fn_blueviolet() {
    assert_eq!(parse("rgb(138, 43, 226)").unwrap(), Rgba::rgb(138, 43, 226));
    assert_eq!(parse("rgba(138,43,226,1)").unwrap().to_hex(), "#8a2be2");
}

#[test]
fn hex_blueviolet() {
    assert_eq!(parse("#8A2BE2").unwrap().to_css(), "rgb(138, 43, 226)");
}

#[test]
fn upper_brown() {
    assert_eq!(parse("  BROWN ").unwrap(), Rgba::rgb(165, 42, 42));
}

#[test]
fn rgb_fn_brown() {
    assert_eq!(parse("rgb(165, 42, 42)").unwrap(), Rgba::rgb(165, 42, 42));
    assert_eq!(parse("rgba(165,42,42,1)").unwrap().to_hex(), "#a52a2a");
}

#[test]
fn hex_brown() {
    assert_eq!(parse("#A52A2A").unwrap().to_css(), "rgb(165, 42, 42)");
}

#[test]
fn upper_burlywood() {
    assert_eq!(parse("  BURLYWOOD ").unwrap(), Rgba::rgb(222, 184, 135));
}

#[test]
fn rgb_fn_burlywood() {
    assert_eq!(parse("rgb(222, 184, 135)").unwrap(), Rgba::rgb(222, 184, 135));
    assert_eq!(parse("rgba(222,184,135,1)").unwrap().to_hex(), "#deb887");
}

#[test]
fn hex_burlywood() {
    assert_eq!(parse("#DEB887").unwrap().to_css(), "rgb(222, 184, 135)");
}

#[test]
fn upper_cadetblue() {
    assert_eq!(parse("  CADETBLUE ").unwrap(), Rgba::rgb(95, 158, 160));
}

#[test]
fn rgb_fn_cadetblue() {
    assert_eq!(parse("rgb(95, 158, 160)").unwrap(), Rgba::rgb(95, 158, 160));
    assert_eq!(parse("rgba(95,158,160,1)").unwrap().to_hex(), "#5f9ea0");
}

#[test]
fn hex_cadetblue() {
    assert_eq!(parse("#5F9EA0").unwrap().to_css(), "rgb(95, 158, 160)");
}

#[test]
fn upper_chartreuse() {
    assert_eq!(parse("  CHARTREUSE ").unwrap(), Rgba::rgb(127, 255, 0));
}

#[test]
fn rgb_fn_chartreuse() {
    assert_eq!(parse("rgb(127, 255, 0)").unwrap(), Rgba::rgb(127, 255, 0));
    assert_eq!(parse("rgba(127,255,0,1)").unwrap().to_hex(), "#7fff00");
}

#[test]
fn hex_chartreuse() {
    assert_eq!(parse("#7FFF00").unwrap().to_css(), "rgb(127, 255, 0)");
}

#[test]
fn upper_chocolate() {
    assert_eq!(parse("  CHOCOLATE ").unwrap(), Rgba::rgb(210, 105, 30));
}

#[test]
fn rgb_fn_chocolate() {
    assert_eq!(parse("rgb(210, 105, 30)").unwrap(), Rgba::rgb(210, 105, 30));
    assert_eq!(parse("rgba(210,105,30,1)").unwrap().to_hex(), "#d2691e");
}

#[test]
fn hex_chocolate() {
    assert_eq!(parse("#D2691E").unwrap().to_css(), "rgb(210, 105, 30)");
}

#[test]
fn upper_coral() {
    assert_eq!(parse("  CORAL ").unwrap(), Rgba::rgb(255, 127, 80));
}

#[test]
fn rgb_fn_coral() {
    assert_eq!(parse("rgb(255, 127, 80)").unwrap(), Rgba::rgb(255, 127, 80));
    assert_eq!(parse("rgba(255,127,80,1)").unwrap().to_hex(), "#ff7f50");
}

#[test]
fn hex_coral() {
    assert_eq!(parse("#FF7F50").unwrap().to_css(), "rgb(255, 127, 80)");
}

#[test]
fn upper_cornflowerblue() {
    assert_eq!(parse("  CORNFLOWERBLUE ").unwrap(), Rgba::rgb(100, 149, 237));
}

#[test]
fn rgb_fn_cornflowerblue() {
    assert_eq!(parse("rgb(100, 149, 237)").unwrap(), Rgba::rgb(100, 149, 237));
    assert_eq!(parse("rgba(100,149,237,1)").unwrap().to_hex(), "#6495ed");
}

#[test]
fn hex_cornflowerblue() {
    assert_eq!(parse("#6495ED").unwrap().to_css(), "rgb(100, 149, 237)");
}

#[test]
fn upper_cornsilk() {
    assert_eq!(parse("  CORNSILK ").unwrap(), Rgba::rgb(255, 248, 220));
}

#[test]
fn rgb_fn_cornsilk() {
    assert_eq!(parse("rgb(255, 248, 220)").unwrap(), Rgba::rgb(255, 248, 220));
    assert_eq!(parse("rgba(255,248,220,1)").unwrap().to_hex(), "#fff8dc");
}

#[test]
fn hex_cornsilk() {
    assert_eq!(parse("#FFF8DC").unwrap().to_css(), "rgb(255, 248, 220)");
}

#[test]
fn upper_crimson() {
    assert_eq!(parse("  CRIMSON ").unwrap(), Rgba::rgb(220, 20, 60));
}

#[test]
fn rgb_fn_crimson() {
    assert_eq!(parse("rgb(220, 20, 60)").unwrap(), Rgba::rgb(220, 20, 60));
    assert_eq!(parse("rgba(220,20,60,1)").unwrap().to_hex(), "#dc143c");
}

#[test]
fn hex_crimson() {
    assert_eq!(parse("#DC143C").unwrap().to_css(), "rgb(220, 20, 60)");
}

#[test]
fn upper_cyan() {
    assert_eq!(parse("  CYAN ").unwrap(), Rgba::rgb(0, 255, 255));
}

#[test]
fn rgb_fn_cyan() {
    assert_eq!(parse("rgb(0, 255, 255)").unwrap(), Rgba::rgb(0, 255, 255));
    assert_eq!(parse("rgba(0,255,255,1)").unwrap().to_hex(), "#00ffff");
}

#[test]
fn hex_cyan() {
    assert_eq!(parse("#00FFFF").unwrap().to_css(), "rgb(0, 255, 255)");
}

#[test]
fn upper_darkblue() {
    assert_eq!(parse("  DARKBLUE ").unwrap(), Rgba::rgb(0, 0, 139));
}

#[test]
fn rgb_fn_darkblue() {
    assert_eq!(parse("rgb(0, 0, 139)").unwrap(), Rgba::rgb(0, 0, 139));
    assert_eq!(parse("rgba(0,0,139,1)").unwrap().to_hex(), "#00008b");
}

#[test]
fn hex_darkblue() {
    assert_eq!(parse("#00008B").unwrap().to_css(), "rgb(0, 0, 139)");
}

#[test]
fn upper_darkcyan() {
    assert_eq!(parse("  DARKCYAN ").unwrap(), Rgba::rgb(0, 139, 139));
}

#[test]
fn rgb_fn_darkcyan() {
    assert_eq!(parse("rgb(0, 139, 139)").unwrap(), Rgba::rgb(0, 139, 139));
    assert_eq!(parse("rgba(0,139,139,1)").unwrap().to_hex(), "#008b8b");
}

#[test]
fn hex_darkcyan() {
    assert_eq!(parse("#008B8B").unwrap().to_css(), "rgb(0, 139, 139)");
}

#[test]
fn upper_darkgoldenrod() {
    assert_eq!(parse("  DARKGOLDENROD ").unwrap(), Rgba::rgb(184, 134, 11));
}

#[test]
fn rgb_fn_darkgoldenrod() {
    assert_eq!(parse("rgb(184, 134, 11)").unwrap(), Rgba::rgb(184, 134, 11));
    assert_eq!(parse("rgba(184,134,11,1)").unwrap().to_hex(), "#b8860b");
}

#[test]
fn hex_darkgoldenrod() {
    assert_eq!(parse("#B8860B").unwrap().to_css(), "rgb(184, 134, 11)");
}

#[test]
fn upper_darkgray() {
    assert_eq!(parse("  DARKGRAY ").unwrap(), Rgba::rgb(169, 169, 169));
}

#[test]
fn rgb_fn_darkgray() {
    assert_eq!(parse("rgb(169, 169, 169)").unwrap(), Rgba::rgb(169, 169, 169));
    assert_eq!(parse("rgba(169,169,169,1)").unwrap().to_hex(), "#a9a9a9");
}

#[test]
fn hex_darkgray() {
    assert_eq!(parse("#A9A9A9").unwrap().to_css(), "rgb(169, 169, 169)");
}

#[test]
fn upper_darkgreen() {
    assert_eq!(parse("  DARKGREEN ").unwrap(), Rgba::rgb(0, 100, 0));
}

#[test]
fn rgb_fn_darkgreen() {
    assert_eq!(parse("rgb(0, 100, 0)").unwrap(), Rgba::rgb(0, 100, 0));
    assert_eq!(parse("rgba(0,100,0,1)").unwrap().to_hex(), "#006400");
}

#[test]
fn hex_darkgreen() {
    assert_eq!(parse("#006400").unwrap().to_css(), "rgb(0, 100, 0)");
}

#[test]
fn upper_darkgrey() {
    assert_eq!(parse("  DARKGREY ").unwrap(), Rgba::rgb(169, 169, 169));
}

#[test]
fn rgb_fn_darkgrey() {
    assert_eq!(parse("rgb(169, 169, 169)").unwrap(), Rgba::rgb(169, 169, 169));
    assert_eq!(parse("rgba(169,169,169,1)").unwrap().to_hex(), "#a9a9a9");
}

#[test]
fn hex_darkgrey() {
    assert_eq!(parse("#A9A9A9").unwrap().to_css(), "rgb(169, 169, 169)");
}

#[test]
fn upper_darkkhaki() {
    assert_eq!(parse("  DARKKHAKI ").unwrap(), Rgba::rgb(189, 183, 107));
}

#[test]
fn rgb_fn_darkkhaki() {
    assert_eq!(parse("rgb(189, 183, 107)").unwrap(), Rgba::rgb(189, 183, 107));
    assert_eq!(parse("rgba(189,183,107,1)").unwrap().to_hex(), "#bdb76b");
}

#[test]
fn hex_darkkhaki() {
    assert_eq!(parse("#BDB76B").unwrap().to_css(), "rgb(189, 183, 107)");
}

#[test]
fn upper_darkmagenta() {
    assert_eq!(parse("  DARKMAGENTA ").unwrap(), Rgba::rgb(139, 0, 139));
}

#[test]
fn rgb_fn_darkmagenta() {
    assert_eq!(parse("rgb(139, 0, 139)").unwrap(), Rgba::rgb(139, 0, 139));
    assert_eq!(parse("rgba(139,0,139,1)").unwrap().to_hex(), "#8b008b");
}

#[test]
fn hex_darkmagenta() {
    assert_eq!(parse("#8B008B").unwrap().to_css(), "rgb(139, 0, 139)");
}

#[test]
fn upper_darkolivegreen() {
    assert_eq!(parse("  DARKOLIVEGREEN ").unwrap(), Rgba::rgb(85, 107, 47));
}

#[test]
fn rgb_fn_darkolivegreen() {
    assert_eq!(parse("rgb(85, 107, 47)").unwrap(), Rgba::rgb(85, 107, 47));
    assert_eq!(parse("rgba(85,107,47,1)").unwrap().to_hex(), "#556b2f");
}

#[test]
fn hex_darkolivegreen() {
    assert_eq!(parse("#556B2F").unwrap().to_css(), "rgb(85, 107, 47)");
}

#[test]
fn upper_darkorange() {
    assert_eq!(parse("  DARKORANGE ").unwrap(), Rgba::rgb(255, 140, 0));
}

#[test]
fn rgb_fn_darkorange() {
    assert_eq!(parse("rgb(255, 140, 0)").unwrap(), Rgba::rgb(255, 140, 0));
    assert_eq!(parse("rgba(255,140,0,1)").unwrap().to_hex(), "#ff8c00");
}

#[test]
fn hex_darkorange() {
    assert_eq!(parse("#FF8C00").unwrap().to_css(), "rgb(255, 140, 0)");
}

#[test]
fn upper_darkorchid() {
    assert_eq!(parse("  DARKORCHID ").unwrap(), Rgba::rgb(153, 50, 204));
}

#[test]
fn rgb_fn_darkorchid() {
    assert_eq!(parse("rgb(153, 50, 204)").unwrap(), Rgba::rgb(153, 50, 204));
    assert_eq!(parse("rgba(153,50,204,1)").unwrap().to_hex(), "#9932cc");
}

#[test]
fn hex_darkorchid() {
    assert_eq!(parse("#9932CC").unwrap().to_css(), "rgb(153, 50, 204)");
}

#[test]
fn upper_darkred() {
    assert_eq!(parse("  DARKRED ").unwrap(), Rgba::rgb(139, 0, 0));
}

#[test]
fn rgb_fn_darkred() {
    assert_eq!(parse("rgb(139, 0, 0)").unwrap(), Rgba::rgb(139, 0, 0));
    assert_eq!(parse("rgba(139,0,0,1)").unwrap().to_hex(), "#8b0000");
}

#[test]
fn hex_darkred() {
    assert_eq!(parse("#8B0000").unwrap().to_css(), "rgb(139, 0, 0)");
}

#[test]
fn upper_darksalmon() {
    assert_eq!(parse("  DARKSALMON ").unwrap(), Rgba::rgb(233, 150, 122));
}

#[test]
fn rgb_fn_darksalmon() {
    assert_eq!(parse("rgb(233, 150, 122)").unwrap(), Rgba::rgb(233, 150, 122));
    assert_eq!(parse("rgba(233,150,122,1)").unwrap().to_hex(), "#e9967a");
}

#[test]
fn hex_darksalmon() {
    assert_eq!(parse("#E9967A").unwrap().to_css(), "rgb(233, 150, 122)");
}

#[test]
fn upper_darkseagreen() {
    assert_eq!(parse("  DARKSEAGREEN ").unwrap(), Rgba::rgb(143, 188, 143));
}

#[test]
fn rgb_fn_darkseagreen() {
    assert_eq!(parse("rgb(143, 188, 143)").unwrap(), Rgba::rgb(143, 188, 143));
    assert_eq!(parse("rgba(143,188,143,1)").unwrap().to_hex(), "#8fbc8f");
}

#[test]
fn hex_darkseagreen() {
    assert_eq!(parse("#8FBC8F").unwrap().to_css(), "rgb(143, 188, 143)");
}

#[test]
fn upper_darkslateblue() {
    assert_eq!(parse("  DARKSLATEBLUE ").unwrap(), Rgba::rgb(72, 61, 139));
}

#[test]
fn rgb_fn_darkslateblue() {
    assert_eq!(parse("rgb(72, 61, 139)").unwrap(), Rgba::rgb(72, 61, 139));
    assert_eq!(parse("rgba(72,61,139,1)").unwrap().to_hex(), "#483d8b");
}

#[test]
fn hex_darkslateblue() {
    assert_eq!(parse("#483D8B").unwrap().to_css(), "rgb(72, 61, 139)");
}

#[test]
fn upper_darkslategray() {
    assert_eq!(parse("  DARKSLATEGRAY ").unwrap(), Rgba::rgb(47, 79, 79));
}

#[test]
fn rgb_fn_darkslategray() {
    assert_eq!(parse("rgb(47, 79, 79)").unwrap(), Rgba::rgb(47, 79, 79));
    assert_eq!(parse("rgba(47,79,79,1)").unwrap().to_hex(), "#2f4f4f");
}

#[test]
fn hex_darkslategray() {
    assert_eq!(parse("#2F4F4F").unwrap().to_css(), "rgb(47, 79, 79)");
}

#[test]
fn upper_darkslategrey() {
    assert_eq!(parse("  DARKSLATEGREY ").unwrap(), Rgba::rgb(47, 79, 79));
}

#[test]
fn rgb_fn_darkslategrey() {
    assert_eq!(parse("rgb(47, 79, 79)").unwrap(), Rgba::rgb(47, 79, 79));
    assert_eq!(parse("rgba(47,79,79,1)").unwrap().to_hex(), "#2f4f4f");
}

#[test]
fn hex_darkslategrey() {
    assert_eq!(parse("#2F4F4F").unwrap().to_css(), "rgb(47, 79, 79)");
}

#[test]
fn upper_darkturquoise() {
    assert_eq!(parse("  DARKTURQUOISE ").unwrap(), Rgba::rgb(0, 206, 209));
}

#[test]
fn rgb_fn_darkturquoise() {
    assert_eq!(parse("rgb(0, 206, 209)").unwrap(), Rgba::rgb(0, 206, 209));
    assert_eq!(parse("rgba(0,206,209,1)").unwrap().to_hex(), "#00ced1");
}

#[test]
fn hex_darkturquoise() {
    assert_eq!(parse("#00CED1").unwrap().to_css(), "rgb(0, 206, 209)");
}

#[test]
fn upper_darkviolet() {
    assert_eq!(parse("  DARKVIOLET ").unwrap(), Rgba::rgb(148, 0, 211));
}

#[test]
fn rgb_fn_darkviolet() {
    assert_eq!(parse("rgb(148, 0, 211)").unwrap(), Rgba::rgb(148, 0, 211));
    assert_eq!(parse("rgba(148,0,211,1)").unwrap().to_hex(), "#9400d3");
}

#[test]
fn hex_darkviolet() {
    assert_eq!(parse("#9400D3").unwrap().to_css(), "rgb(148, 0, 211)");
}

#[test]
fn upper_deeppink() {
    assert_eq!(parse("  DEEPPINK ").unwrap(), Rgba::rgb(255, 20, 147));
}

#[test]
fn rgb_fn_deeppink() {
    assert_eq!(parse("rgb(255, 20, 147)").unwrap(), Rgba::rgb(255, 20, 147));
    assert_eq!(parse("rgba(255,20,147,1)").unwrap().to_hex(), "#ff1493");
}

#[test]
fn hex_deeppink() {
    assert_eq!(parse("#FF1493").unwrap().to_css(), "rgb(255, 20, 147)");
}

#[test]
fn upper_deepskyblue() {
    assert_eq!(parse("  DEEPSKYBLUE ").unwrap(), Rgba::rgb(0, 191, 255));
}

#[test]
fn rgb_fn_deepskyblue() {
    assert_eq!(parse("rgb(0, 191, 255)").unwrap(), Rgba::rgb(0, 191, 255));
    assert_eq!(parse("rgba(0,191,255,1)").unwrap().to_hex(), "#00bfff");
}

#[test]
fn hex_deepskyblue() {
    assert_eq!(parse("#00BFFF").unwrap().to_css(), "rgb(0, 191, 255)");
}

#[test]
fn upper_dimgray() {
    assert_eq!(parse("  DIMGRAY ").unwrap(), Rgba::rgb(105, 105, 105));
}

#[test]
fn rgb_fn_dimgray() {
    assert_eq!(parse("rgb(105, 105, 105)").unwrap(), Rgba::rgb(105, 105, 105));
    assert_eq!(parse("rgba(105,105,105,1)").unwrap().to_hex(), "#696969");
}

#[test]
fn hex_dimgray() {
    assert_eq!(parse("#696969").unwrap().to_css(), "rgb(105, 105, 105)");
}

#[test]
fn upper_dimgrey() {
    assert_eq!(parse("  DIMGREY ").unwrap(), Rgba::rgb(105, 105, 105));
}

#[test]
fn rgb_fn_dimgrey() {
    assert_eq!(parse("rgb(105, 105, 105)").unwrap(), Rgba::rgb(105, 105, 105));
    assert_eq!(parse("rgba(105,105,105,1)").unwrap().to_hex(), "#696969");
}

#[test]
fn hex_dimgrey() {
    assert_eq!(parse("#696969").unwrap().to_css(), "rgb(105, 105, 105)");
}

#[test]
fn upper_dodgerblue() {
    assert_eq!(parse("  DODGERBLUE ").unwrap(), Rgba::rgb(30, 144, 255));
}

#[test]
fn rgb_fn_dodgerblue() {
    assert_eq!(parse("rgb(30, 144, 255)").unwrap(), Rgba::rgb(30, 144, 255));
    assert_eq!(parse("rgba(30,144,255,1)").unwrap().to_hex(), "#1e90ff");
}

#[test]
fn hex_dodgerblue() {
    assert_eq!(parse("#1E90FF").unwrap().to_css(), "rgb(30, 144, 255)");
}

#[test]
fn upper_firebrick() {
    assert_eq!(parse("  FIREBRICK ").unwrap(), Rgba::rgb(178, 34, 34));
}

#[test]
fn rgb_fn_firebrick() {
    assert_eq!(parse("rgb(178, 34, 34)").unwrap(), Rgba::rgb(178, 34, 34));
    assert_eq!(parse("rgba(178,34,34,1)").unwrap().to_hex(), "#b22222");
}

#[test]
fn hex_firebrick() {
    assert_eq!(parse("#B22222").unwrap().to_css(), "rgb(178, 34, 34)");
}

#[test]
fn upper_floralwhite() {
    assert_eq!(parse("  FLORALWHITE ").unwrap(), Rgba::rgb(255, 250, 240));
}

#[test]
fn rgb_fn_floralwhite() {
    assert_eq!(parse("rgb(255, 250, 240)").unwrap(), Rgba::rgb(255, 250, 240));
    assert_eq!(parse("rgba(255,250,240,1)").unwrap().to_hex(), "#fffaf0");
}

#[test]
fn hex_floralwhite() {
    assert_eq!(parse("#FFFAF0").unwrap().to_css(), "rgb(255, 250, 240)");
}

#[test]
fn upper_forestgreen() {
    assert_eq!(parse("  FORESTGREEN ").unwrap(), Rgba::rgb(34, 139, 34));
}

#[test]
fn rgb_fn_forestgreen() {
    assert_eq!(parse("rgb(34, 139, 34)").unwrap(), Rgba::rgb(34, 139, 34));
    assert_eq!(parse("rgba(34,139,34,1)").unwrap().to_hex(), "#228b22");
}

#[test]
fn hex_forestgreen() {
    assert_eq!(parse("#228B22").unwrap().to_css(), "rgb(34, 139, 34)");
}

#[test]
fn upper_fuchsia() {
    assert_eq!(parse("  FUCHSIA ").unwrap(), Rgba::rgb(255, 0, 255));
}

#[test]
fn rgb_fn_fuchsia() {
    assert_eq!(parse("rgb(255, 0, 255)").unwrap(), Rgba::rgb(255, 0, 255));
    assert_eq!(parse("rgba(255,0,255,1)").unwrap().to_hex(), "#ff00ff");
}

#[test]
fn hex_fuchsia() {
    assert_eq!(parse("#FF00FF").unwrap().to_css(), "rgb(255, 0, 255)");
}

#[test]
fn upper_gainsboro() {
    assert_eq!(parse("  GAINSBORO ").unwrap(), Rgba::rgb(220, 220, 220));
}

#[test]
fn rgb_fn_gainsboro() {
    assert_eq!(parse("rgb(220, 220, 220)").unwrap(), Rgba::rgb(220, 220, 220));
    assert_eq!(parse("rgba(220,220,220,1)").unwrap().to_hex(), "#dcdcdc");
}

#[test]
fn hex_gainsboro() {
    assert_eq!(parse("#DCDCDC").unwrap().to_css(), "rgb(220, 220, 220)");
}

#[test]
fn upper_ghostwhite() {
    assert_eq!(parse("  GHOSTWHITE ").unwrap(), Rgba::rgb(248, 248, 255));
}

#[test]
fn rgb_fn_ghostwhite() {
    assert_eq!(parse("rgb(248, 248, 255)").unwrap(), Rgba::rgb(248, 248, 255));
    assert_eq!(parse("rgba(248,248,255,1)").unwrap().to_hex(), "#f8f8ff");
}

#[test]
fn hex_ghostwhite() {
    assert_eq!(parse("#F8F8FF").unwrap().to_css(), "rgb(248, 248, 255)");
}

#[test]
fn upper_gold() {
    assert_eq!(parse("  GOLD ").unwrap(), Rgba::rgb(255, 215, 0));
}

#[test]
fn rgb_fn_gold() {
    assert_eq!(parse("rgb(255, 215, 0)").unwrap(), Rgba::rgb(255, 215, 0));
    assert_eq!(parse("rgba(255,215,0,1)").unwrap().to_hex(), "#ffd700");
}

#[test]
fn hex_gold() {
    assert_eq!(parse("#FFD700").unwrap().to_css(), "rgb(255, 215, 0)");
}

#[test]
fn upper_goldenrod() {
    assert_eq!(parse("  GOLDENROD ").unwrap(), Rgba::rgb(218, 165, 32));
}

#[test]
fn rgb_fn_goldenrod() {
    assert_eq!(parse("rgb(218, 165, 32)").unwrap(), Rgba::rgb(218, 165, 32));
    assert_eq!(parse("rgba(218,165,32,1)").unwrap().to_hex(), "#daa520");
}

#[test]
fn hex_goldenrod() {
    assert_eq!(parse("#DAA520").unwrap().to_css(), "rgb(218, 165, 32)");
}

#[test]
fn upper_gray() {
    assert_eq!(parse("  GRAY ").unwrap(), Rgba::rgb(128, 128, 128));
}

#[test]
fn rgb_fn_gray() {
    assert_eq!(parse("rgb(128, 128, 128)").unwrap(), Rgba::rgb(128, 128, 128));
    assert_eq!(parse("rgba(128,128,128,1)").unwrap().to_hex(), "#808080");
}

#[test]
fn hex_gray() {
    assert_eq!(parse("#808080").unwrap().to_css(), "rgb(128, 128, 128)");
}

#[test]
fn upper_green() {
    assert_eq!(parse("  GREEN ").unwrap(), Rgba::rgb(0, 128, 0));
}

#[test]
fn rgb_fn_green() {
    assert_eq!(parse("rgb(0, 128, 0)").unwrap(), Rgba::rgb(0, 128, 0));
    assert_eq!(parse("rgba(0,128,0,1)").unwrap().to_hex(), "#008000");
}

#[test]
fn hex_green() {
    assert_eq!(parse("#008000").unwrap().to_css(), "rgb(0, 128, 0)");
}

#[test]
fn upper_greenyellow() {
    assert_eq!(parse("  GREENYELLOW ").unwrap(), Rgba::rgb(173, 255, 47));
}

#[test]
fn rgb_fn_greenyellow() {
    assert_eq!(parse("rgb(173, 255, 47)").unwrap(), Rgba::rgb(173, 255, 47));
    assert_eq!(parse("rgba(173,255,47,1)").unwrap().to_hex(), "#adff2f");
}

#[test]
fn hex_greenyellow() {
    assert_eq!(parse("#ADFF2F").unwrap().to_css(), "rgb(173, 255, 47)");
}

#[test]
fn upper_grey() {
    assert_eq!(parse("  GREY ").unwrap(), Rgba::rgb(128, 128, 128));
}

#[test]
fn rgb_fn_grey() {
    assert_eq!(parse("rgb(128, 128, 128)").unwrap(), Rgba::rgb(128, 128, 128));
    assert_eq!(parse("rgba(128,128,128,1)").unwrap().to_hex(), "#808080");
}

#[test]
fn hex_grey() {
    assert_eq!(parse("#808080").unwrap().to_css(), "rgb(128, 128, 128)");
}

#[test]
fn upper_honeydew() {
    assert_eq!(parse("  HONEYDEW ").unwrap(), Rgba::rgb(240, 255, 240));
}

#[test]
fn rgb_fn_honeydew() {
    assert_eq!(parse("rgb(240, 255, 240)").unwrap(), Rgba::rgb(240, 255, 240));
    assert_eq!(parse("rgba(240,255,240,1)").unwrap().to_hex(), "#f0fff0");
}

#[test]
fn hex_honeydew() {
    assert_eq!(parse("#F0FFF0").unwrap().to_css(), "rgb(240, 255, 240)");
}

#[test]
fn upper_hotpink() {
    assert_eq!(parse("  HOTPINK ").unwrap(), Rgba::rgb(255, 105, 180));
}

#[test]
fn rgb_fn_hotpink() {
    assert_eq!(parse("rgb(255, 105, 180)").unwrap(), Rgba::rgb(255, 105, 180));
    assert_eq!(parse("rgba(255,105,180,1)").unwrap().to_hex(), "#ff69b4");
}

#[test]
fn hex_hotpink() {
    assert_eq!(parse("#FF69B4").unwrap().to_css(), "rgb(255, 105, 180)");
}

#[test]
fn upper_indianred() {
    assert_eq!(parse("  INDIANRED ").unwrap(), Rgba::rgb(205, 92, 92));
}

#[test]
fn rgb_fn_indianred() {
    assert_eq!(parse("rgb(205, 92, 92)").unwrap(), Rgba::rgb(205, 92, 92));
    assert_eq!(parse("rgba(205,92,92,1)").unwrap().to_hex(), "#cd5c5c");
}

#[test]
fn hex_indianred() {
    assert_eq!(parse("#CD5C5C").unwrap().to_css(), "rgb(205, 92, 92)");
}

#[test]
fn upper_indigo() {
    assert_eq!(parse("  INDIGO ").unwrap(), Rgba::rgb(75, 0, 130));
}

#[test]
fn rgb_fn_indigo() {
    assert_eq!(parse("rgb(75, 0, 130)").unwrap(), Rgba::rgb(75, 0, 130));
    assert_eq!(parse("rgba(75,0,130,1)").unwrap().to_hex(), "#4b0082");
}

#[test]
fn hex_indigo() {
    assert_eq!(parse("#4B0082").unwrap().to_css(), "rgb(75, 0, 130)");
}

#[test]
fn upper_ivory() {
    assert_eq!(parse("  IVORY ").unwrap(), Rgba::rgb(255, 255, 240));
}

#[test]
fn rgb_fn_ivory() {
    assert_eq!(parse("rgb(255, 255, 240)").unwrap(), Rgba::rgb(255, 255, 240));
    assert_eq!(parse("rgba(255,255,240,1)").unwrap().to_hex(), "#fffff0");
}

#[test]
fn hex_ivory() {
    assert_eq!(parse("#FFFFF0").unwrap().to_css(), "rgb(255, 255, 240)");
}

#[test]
fn upper_khaki() {
    assert_eq!(parse("  KHAKI ").unwrap(), Rgba::rgb(240, 230, 140));
}

#[test]
fn rgb_fn_khaki() {
    assert_eq!(parse("rgb(240, 230, 140)").unwrap(), Rgba::rgb(240, 230, 140));
    assert_eq!(parse("rgba(240,230,140,1)").unwrap().to_hex(), "#f0e68c");
}

#[test]
fn hex_khaki() {
    assert_eq!(parse("#F0E68C").unwrap().to_css(), "rgb(240, 230, 140)");
}

#[test]
fn upper_lavender() {
    assert_eq!(parse("  LAVENDER ").unwrap(), Rgba::rgb(230, 230, 250));
}

#[test]
fn rgb_fn_lavender() {
    assert_eq!(parse("rgb(230, 230, 250)").unwrap(), Rgba::rgb(230, 230, 250));
    assert_eq!(parse("rgba(230,230,250,1)").unwrap().to_hex(), "#e6e6fa");
}

#[test]
fn hex_lavender() {
    assert_eq!(parse("#E6E6FA").unwrap().to_css(), "rgb(230, 230, 250)");
}

#[test]
fn upper_lavenderblush() {
    assert_eq!(parse("  LAVENDERBLUSH ").unwrap(), Rgba::rgb(255, 240, 245));
}

#[test]
fn rgb_fn_lavenderblush() {
    assert_eq!(parse("rgb(255, 240, 245)").unwrap(), Rgba::rgb(255, 240, 245));
    assert_eq!(parse("rgba(255,240,245,1)").unwrap().to_hex(), "#fff0f5");
}

#[test]
fn hex_lavenderblush() {
    assert_eq!(parse("#FFF0F5").unwrap().to_css(), "rgb(255, 240, 245)");
}

#[test]
fn upper_lawngreen() {
    assert_eq!(parse("  LAWNGREEN ").unwrap(), Rgba::rgb(124, 252, 0));
}

#[test]
fn rgb_fn_lawngreen() {
    assert_eq!(parse("rgb(124, 252, 0)").unwrap(), Rgba::rgb(124, 252, 0));
    assert_eq!(parse("rgba(124,252,0,1)").unwrap().to_hex(), "#7cfc00");
}

#[test]
fn hex_lawngreen() {
    assert_eq!(parse("#7CFC00").unwrap().to_css(), "rgb(124, 252, 0)");
}

#[test]
fn upper_lemonchiffon() {
    assert_eq!(parse("  LEMONCHIFFON ").unwrap(), Rgba::rgb(255, 250, 205));
}

#[test]
fn rgb_fn_lemonchiffon() {
    assert_eq!(parse("rgb(255, 250, 205)").unwrap(), Rgba::rgb(255, 250, 205));
    assert_eq!(parse("rgba(255,250,205,1)").unwrap().to_hex(), "#fffacd");
}

#[test]
fn hex_lemonchiffon() {
    assert_eq!(parse("#FFFACD").unwrap().to_css(), "rgb(255, 250, 205)");
}

#[test]
fn upper_lightblue() {
    assert_eq!(parse("  LIGHTBLUE ").unwrap(), Rgba::rgb(173, 216, 230));
}

#[test]
fn rgb_fn_lightblue() {
    assert_eq!(parse("rgb(173, 216, 230)").unwrap(), Rgba::rgb(173, 216, 230));
    assert_eq!(parse("rgba(173,216,230,1)").unwrap().to_hex(), "#add8e6");
}

#[test]
fn hex_lightblue() {
    assert_eq!(parse("#ADD8E6").unwrap().to_css(), "rgb(173, 216, 230)");
}

#[test]
fn upper_lightcoral() {
    assert_eq!(parse("  LIGHTCORAL ").unwrap(), Rgba::rgb(240, 128, 128));
}

#[test]
fn rgb_fn_lightcoral() {
    assert_eq!(parse("rgb(240, 128, 128)").unwrap(), Rgba::rgb(240, 128, 128));
    assert_eq!(parse("rgba(240,128,128,1)").unwrap().to_hex(), "#f08080");
}

#[test]
fn hex_lightcoral() {
    assert_eq!(parse("#F08080").unwrap().to_css(), "rgb(240, 128, 128)");
}

#[test]
fn upper_lightcyan() {
    assert_eq!(parse("  LIGHTCYAN ").unwrap(), Rgba::rgb(224, 255, 255));
}

#[test]
fn rgb_fn_lightcyan() {
    assert_eq!(parse("rgb(224, 255, 255)").unwrap(), Rgba::rgb(224, 255, 255));
    assert_eq!(parse("rgba(224,255,255,1)").unwrap().to_hex(), "#e0ffff");
}

#[test]
fn hex_lightcyan() {
    assert_eq!(parse("#E0FFFF").unwrap().to_css(), "rgb(224, 255, 255)");
}

#[test]
fn upper_lightgoldenrodyellow() {
    assert_eq!(parse("  LIGHTGOLDENRODYELLOW ").unwrap(), Rgba::rgb(250, 250, 210));
}

#[test]
fn rgb_fn_lightgoldenrodyellow() {
    assert_eq!(parse("rgb(250, 250, 210)").unwrap(), Rgba::rgb(250, 250, 210));
    assert_eq!(parse("rgba(250,250,210,1)").unwrap().to_hex(), "#fafad2");
}

#[test]
fn hex_lightgoldenrodyellow() {
    assert_eq!(parse("#FAFAD2").unwrap().to_css(), "rgb(250, 250, 210)");
}

#[test]
fn upper_lightgray() {
    assert_eq!(parse("  LIGHTGRAY ").unwrap(), Rgba::rgb(211, 211, 211));
}

#[test]
fn rgb_fn_lightgray() {
    assert_eq!(parse("rgb(211, 211, 211)").unwrap(), Rgba::rgb(211, 211, 211));
    assert_eq!(parse("rgba(211,211,211,1)").unwrap().to_hex(), "#d3d3d3");
}

#[test]
fn hex_lightgray() {
    assert_eq!(parse("#D3D3D3").unwrap().to_css(), "rgb(211, 211, 211)");
}

#[test]
fn upper_lightgreen() {
    assert_eq!(parse("  LIGHTGREEN ").unwrap(), Rgba::rgb(144, 238, 144));
}

#[test]
fn rgb_fn_lightgreen() {
    assert_eq!(parse("rgb(144, 238, 144)").unwrap(), Rgba::rgb(144, 238, 144));
    assert_eq!(parse("rgba(144,238,144,1)").unwrap().to_hex(), "#90ee90");
}

#[test]
fn hex_lightgreen() {
    assert_eq!(parse("#90EE90").unwrap().to_css(), "rgb(144, 238, 144)");
}

#[test]
fn upper_lightgrey() {
    assert_eq!(parse("  LIGHTGREY ").unwrap(), Rgba::rgb(211, 211, 211));
}

#[test]
fn rgb_fn_lightgrey() {
    assert_eq!(parse("rgb(211, 211, 211)").unwrap(), Rgba::rgb(211, 211, 211));
    assert_eq!(parse("rgba(211,211,211,1)").unwrap().to_hex(), "#d3d3d3");
}

#[test]
fn hex_lightgrey() {
    assert_eq!(parse("#D3D3D3").unwrap().to_css(), "rgb(211, 211, 211)");
}

#[test]
fn upper_lightpink() {
    assert_eq!(parse("  LIGHTPINK ").unwrap(), Rgba::rgb(255, 182, 193));
}

#[test]
fn rgb_fn_lightpink() {
    assert_eq!(parse("rgb(255, 182, 193)").unwrap(), Rgba::rgb(255, 182, 193));
    assert_eq!(parse("rgba(255,182,193,1)").unwrap().to_hex(), "#ffb6c1");
}

#[test]
fn hex_lightpink() {
    assert_eq!(parse("#FFB6C1").unwrap().to_css(), "rgb(255, 182, 193)");
}

#[test]
fn upper_lightsalmon() {
    assert_eq!(parse("  LIGHTSALMON ").unwrap(), Rgba::rgb(255, 160, 122));
}

#[test]
fn rgb_fn_lightsalmon() {
    assert_eq!(parse("rgb(255, 160, 122)").unwrap(), Rgba::rgb(255, 160, 122));
    assert_eq!(parse("rgba(255,160,122,1)").unwrap().to_hex(), "#ffa07a");
}

#[test]
fn hex_lightsalmon() {
    assert_eq!(parse("#FFA07A").unwrap().to_css(), "rgb(255, 160, 122)");
}

#[test]
fn upper_lightseagreen() {
    assert_eq!(parse("  LIGHTSEAGREEN ").unwrap(), Rgba::rgb(32, 178, 170));
}

#[test]
fn rgb_fn_lightseagreen() {
    assert_eq!(parse("rgb(32, 178, 170)").unwrap(), Rgba::rgb(32, 178, 170));
    assert_eq!(parse("rgba(32,178,170,1)").unwrap().to_hex(), "#20b2aa");
}

#[test]
fn hex_lightseagreen() {
    assert_eq!(parse("#20B2AA").unwrap().to_css(), "rgb(32, 178, 170)");
}

#[test]
fn upper_lightskyblue() {
    assert_eq!(parse("  LIGHTSKYBLUE ").unwrap(), Rgba::rgb(135, 206, 250));
}

#[test]
fn rgb_fn_lightskyblue() {
    assert_eq!(parse("rgb(135, 206, 250)").unwrap(), Rgba::rgb(135, 206, 250));
    assert_eq!(parse("rgba(135,206,250,1)").unwrap().to_hex(), "#87cefa");
}

#[test]
fn hex_lightskyblue() {
    assert_eq!(parse("#87CEFA").unwrap().to_css(), "rgb(135, 206, 250)");
}

#[test]
fn upper_lightslategray() {
    assert_eq!(parse("  LIGHTSLATEGRAY ").unwrap(), Rgba::rgb(119, 136, 153));
}

#[test]
fn rgb_fn_lightslategray() {
    assert_eq!(parse("rgb(119, 136, 153)").unwrap(), Rgba::rgb(119, 136, 153));
    assert_eq!(parse("rgba(119,136,153,1)").unwrap().to_hex(), "#778899");
}

#[test]
fn hex_lightslategray() {
    assert_eq!(parse("#778899").unwrap().to_css(), "rgb(119, 136, 153)");
}

#[test]
fn upper_lightslategrey() {
    assert_eq!(parse("  LIGHTSLATEGREY ").unwrap(), Rgba::rgb(119, 136, 153));
}

#[test]
fn rgb_fn_lightslategrey() {
    assert_eq!(parse("rgb(119, 136, 153)").unwrap(), Rgba::rgb(119, 136, 153));
    assert_eq!(parse("rgba(119,136,153,1)").unwrap().to_hex(), "#778899");
}

#[test]
fn hex_lightslategrey() {
    assert_eq!(parse("#778899").unwrap().to_css(), "rgb(119, 136, 153)");
}

#[test]
fn upper_lightsteelblue() {
    assert_eq!(parse("  LIGHTSTEELBLUE ").unwrap(), Rgba::rgb(176, 196, 222));
}

#[test]
fn rgb_fn_lightsteelblue() {
    assert_eq!(parse("rgb(176, 196, 222)").unwrap(), Rgba::rgb(176, 196, 222));
    assert_eq!(parse("rgba(176,196,222,1)").unwrap().to_hex(), "#b0c4de");
}

#[test]
fn hex_lightsteelblue() {
    assert_eq!(parse("#B0C4DE").unwrap().to_css(), "rgb(176, 196, 222)");
}

#[test]
fn upper_lightyellow() {
    assert_eq!(parse("  LIGHTYELLOW ").unwrap(), Rgba::rgb(255, 255, 224));
}

#[test]
fn rgb_fn_lightyellow() {
    assert_eq!(parse("rgb(255, 255, 224)").unwrap(), Rgba::rgb(255, 255, 224));
    assert_eq!(parse("rgba(255,255,224,1)").unwrap().to_hex(), "#ffffe0");
}

#[test]
fn hex_lightyellow() {
    assert_eq!(parse("#FFFFE0").unwrap().to_css(), "rgb(255, 255, 224)");
}

#[test]
fn upper_lime() {
    assert_eq!(parse("  LIME ").unwrap(), Rgba::rgb(0, 255, 0));
}

#[test]
fn rgb_fn_lime() {
    assert_eq!(parse("rgb(0, 255, 0)").unwrap(), Rgba::rgb(0, 255, 0));
    assert_eq!(parse("rgba(0,255,0,1)").unwrap().to_hex(), "#00ff00");
}

#[test]
fn hex_lime() {
    assert_eq!(parse("#00FF00").unwrap().to_css(), "rgb(0, 255, 0)");
}

#[test]
fn upper_limegreen() {
    assert_eq!(parse("  LIMEGREEN ").unwrap(), Rgba::rgb(50, 205, 50));
}

#[test]
fn rgb_fn_limegreen() {
    assert_eq!(parse("rgb(50, 205, 50)").unwrap(), Rgba::rgb(50, 205, 50));
    assert_eq!(parse("rgba(50,205,50,1)").unwrap().to_hex(), "#32cd32");
}

#[test]
fn hex_limegreen() {
    assert_eq!(parse("#32CD32").unwrap().to_css(), "rgb(50, 205, 50)");
}

#[test]
fn upper_linen() {
    assert_eq!(parse("  LINEN ").unwrap(), Rgba::rgb(250, 240, 230));
}

#[test]
fn rgb_fn_linen() {
    assert_eq!(parse("rgb(250, 240, 230)").unwrap(), Rgba::rgb(250, 240, 230));
    assert_eq!(parse("rgba(250,240,230,1)").unwrap().to_hex(), "#faf0e6");
}

#[test]
fn hex_linen() {
    assert_eq!(parse("#FAF0E6").unwrap().to_css(), "rgb(250, 240, 230)");
}

#[test]
fn upper_magenta() {
    assert_eq!(parse("  MAGENTA ").unwrap(), Rgba::rgb(255, 0, 255));
}

#[test]
fn rgb_fn_magenta() {
    assert_eq!(parse("rgb(255, 0, 255)").unwrap(), Rgba::rgb(255, 0, 255));
    assert_eq!(parse("rgba(255,0,255,1)").unwrap().to_hex(), "#ff00ff");
}

#[test]
fn hex_magenta() {
    assert_eq!(parse("#FF00FF").unwrap().to_css(), "rgb(255, 0, 255)");
}

#[test]
fn upper_maroon() {
    assert_eq!(parse("  MAROON ").unwrap(), Rgba::rgb(128, 0, 0));
}

#[test]
fn rgb_fn_maroon() {
    assert_eq!(parse("rgb(128, 0, 0)").unwrap(), Rgba::rgb(128, 0, 0));
    assert_eq!(parse("rgba(128,0,0,1)").unwrap().to_hex(), "#800000");
}

#[test]
fn hex_maroon() {
    assert_eq!(parse("#800000").unwrap().to_css(), "rgb(128, 0, 0)");
}

#[test]
fn upper_mediumaquamarine() {
    assert_eq!(parse("  MEDIUMAQUAMARINE ").unwrap(), Rgba::rgb(102, 205, 170));
}

#[test]
fn rgb_fn_mediumaquamarine() {
    assert_eq!(parse("rgb(102, 205, 170)").unwrap(), Rgba::rgb(102, 205, 170));
    assert_eq!(parse("rgba(102,205,170,1)").unwrap().to_hex(), "#66cdaa");
}

#[test]
fn hex_mediumaquamarine() {
    assert_eq!(parse("#66CDAA").unwrap().to_css(), "rgb(102, 205, 170)");
}

#[test]
fn upper_mediumblue() {
    assert_eq!(parse("  MEDIUMBLUE ").unwrap(), Rgba::rgb(0, 0, 205));
}

#[test]
fn rgb_fn_mediumblue() {
    assert_eq!(parse("rgb(0, 0, 205)").unwrap(), Rgba::rgb(0, 0, 205));
    assert_eq!(parse("rgba(0,0,205,1)").unwrap().to_hex(), "#0000cd");
}

#[test]
fn hex_mediumblue() {
    assert_eq!(parse("#0000CD").unwrap().to_css(), "rgb(0, 0, 205)");
}

#[test]
fn upper_mediumorchid() {
    assert_eq!(parse("  MEDIUMORCHID ").unwrap(), Rgba::rgb(186, 85, 211));
}

#[test]
fn rgb_fn_mediumorchid() {
    assert_eq!(parse("rgb(186, 85, 211)").unwrap(), Rgba::rgb(186, 85, 211));
    assert_eq!(parse("rgba(186,85,211,1)").unwrap().to_hex(), "#ba55d3");
}

#[test]
fn hex_mediumorchid() {
    assert_eq!(parse("#BA55D3").unwrap().to_css(), "rgb(186, 85, 211)");
}

#[test]
fn upper_mediumpurple() {
    assert_eq!(parse("  MEDIUMPURPLE ").unwrap(), Rgba::rgb(147, 112, 219));
}

#[test]
fn rgb_fn_mediumpurple() {
    assert_eq!(parse("rgb(147, 112, 219)").unwrap(), Rgba::rgb(147, 112, 219));
    assert_eq!(parse("rgba(147,112,219,1)").unwrap().to_hex(), "#9370db");
}

#[test]
fn hex_mediumpurple() {
    assert_eq!(parse("#9370DB").unwrap().to_css(), "rgb(147, 112, 219)");
}

#[test]
fn upper_mediumseagreen() {
    assert_eq!(parse("  MEDIUMSEAGREEN ").unwrap(), Rgba::rgb(60, 179, 113));
}

#[test]
fn rgb_fn_mediumseagreen() {
    assert_eq!(parse("rgb(60, 179, 113)").unwrap(), Rgba::rgb(60, 179, 113));
    assert_eq!(parse("rgba(60,179,113,1)").unwrap().to_hex(), "#3cb371");
}

#[test]
fn hex_mediumseagreen() {
    assert_eq!(parse("#3CB371").unwrap().to_css(), "rgb(60, 179, 113)");
}

#[test]
fn upper_mediumslateblue() {
    assert_eq!(parse("  MEDIUMSLATEBLUE ").unwrap(), Rgba::rgb(123, 104, 238));
}

#[test]
fn rgb_fn_mediumslateblue() {
    assert_eq!(parse("rgb(123, 104, 238)").unwrap(), Rgba::rgb(123, 104, 238));
    assert_eq!(parse("rgba(123,104,238,1)").unwrap().to_hex(), "#7b68ee");
}

#[test]
fn hex_mediumslateblue() {
    assert_eq!(parse("#7B68EE").unwrap().to_css(), "rgb(123, 104, 238)");
}

#[test]
fn upper_mediumspringgreen() {
    assert_eq!(parse("  MEDIUMSPRINGGREEN ").unwrap(), Rgba::rgb(0, 250, 154));
}

#[test]
fn rgb_fn_mediumspringgreen() {
    assert_eq!(parse("rgb(0, 250, 154)").unwrap(), Rgba::rgb(0, 250, 154));
    assert_eq!(parse("rgba(0,250,154,1)").unwrap().to_hex(), "#00fa9a");
}

#[test]
fn hex_mediumspringgreen() {
    assert_eq!(parse("#00FA9A").unwrap().to_css(), "rgb(0, 250, 154)");
}

#[test]
fn upper_mediumturquoise() {
    assert_eq!(parse("  MEDIUMTURQUOISE ").unwrap(), Rgba::rgb(72, 209, 204));
}

#[test]
fn rgb_fn_mediumturquoise() {
    assert_eq!(parse("rgb(72, 209, 204)").unwrap(), Rgba::rgb(72, 209, 204));
    assert_eq!(parse("rgba(72,209,204,1)").unwrap().to_hex(), "#48d1cc");
}

#[test]
fn hex_mediumturquoise() {
    assert_eq!(parse("#48D1CC").unwrap().to_css(), "rgb(72, 209, 204)");
}

#[test]
fn upper_mediumvioletred() {
    assert_eq!(parse("  MEDIUMVIOLETRED ").unwrap(), Rgba::rgb(199, 21, 133));
}

#[test]
fn rgb_fn_mediumvioletred() {
    assert_eq!(parse("rgb(199, 21, 133)").unwrap(), Rgba::rgb(199, 21, 133));
    assert_eq!(parse("rgba(199,21,133,1)").unwrap().to_hex(), "#c71585");
}

#[test]
fn hex_mediumvioletred() {
    assert_eq!(parse("#C71585").unwrap().to_css(), "rgb(199, 21, 133)");
}

#[test]
fn upper_midnightblue() {
    assert_eq!(parse("  MIDNIGHTBLUE ").unwrap(), Rgba::rgb(25, 25, 112));
}

#[test]
fn rgb_fn_midnightblue() {
    assert_eq!(parse("rgb(25, 25, 112)").unwrap(), Rgba::rgb(25, 25, 112));
    assert_eq!(parse("rgba(25,25,112,1)").unwrap().to_hex(), "#191970");
}

#[test]
fn hex_midnightblue() {
    assert_eq!(parse("#191970").unwrap().to_css(), "rgb(25, 25, 112)");
}

#[test]
fn upper_mintcream() {
    assert_eq!(parse("  MINTCREAM ").unwrap(), Rgba::rgb(245, 255, 250));
}

#[test]
fn rgb_fn_mintcream() {
    assert_eq!(parse("rgb(245, 255, 250)").unwrap(), Rgba::rgb(245, 255, 250));
    assert_eq!(parse("rgba(245,255,250,1)").unwrap().to_hex(), "#f5fffa");
}

#[test]
fn hex_mintcream() {
    assert_eq!(parse("#F5FFFA").unwrap().to_css(), "rgb(245, 255, 250)");
}

#[test]
fn upper_mistyrose() {
    assert_eq!(parse("  MISTYROSE ").unwrap(), Rgba::rgb(255, 228, 225));
}

#[test]
fn rgb_fn_mistyrose() {
    assert_eq!(parse("rgb(255, 228, 225)").unwrap(), Rgba::rgb(255, 228, 225));
    assert_eq!(parse("rgba(255,228,225,1)").unwrap().to_hex(), "#ffe4e1");
}

#[test]
fn hex_mistyrose() {
    assert_eq!(parse("#FFE4E1").unwrap().to_css(), "rgb(255, 228, 225)");
}

#[test]
fn upper_moccasin() {
    assert_eq!(parse("  MOCCASIN ").unwrap(), Rgba::rgb(255, 228, 181));
}

#[test]
fn rgb_fn_moccasin() {
    assert_eq!(parse("rgb(255, 228, 181)").unwrap(), Rgba::rgb(255, 228, 181));
    assert_eq!(parse("rgba(255,228,181,1)").unwrap().to_hex(), "#ffe4b5");
}

#[test]
fn hex_moccasin() {
    assert_eq!(parse("#FFE4B5").unwrap().to_css(), "rgb(255, 228, 181)");
}

#[test]
fn upper_navajowhite() {
    assert_eq!(parse("  NAVAJOWHITE ").unwrap(), Rgba::rgb(255, 222, 173));
}

#[test]
fn rgb_fn_navajowhite() {
    assert_eq!(parse("rgb(255, 222, 173)").unwrap(), Rgba::rgb(255, 222, 173));
    assert_eq!(parse("rgba(255,222,173,1)").unwrap().to_hex(), "#ffdead");
}

#[test]
fn hex_navajowhite() {
    assert_eq!(parse("#FFDEAD").unwrap().to_css(), "rgb(255, 222, 173)");
}

#[test]
fn upper_navy() {
    assert_eq!(parse("  NAVY ").unwrap(), Rgba::rgb(0, 0, 128));
}

#[test]
fn rgb_fn_navy() {
    assert_eq!(parse("rgb(0, 0, 128)").unwrap(), Rgba::rgb(0, 0, 128));
    assert_eq!(parse("rgba(0,0,128,1)").unwrap().to_hex(), "#000080");
}

#[test]
fn hex_navy() {
    assert_eq!(parse("#000080").unwrap().to_css(), "rgb(0, 0, 128)");
}

#[test]
fn upper_oldlace() {
    assert_eq!(parse("  OLDLACE ").unwrap(), Rgba::rgb(253, 245, 230));
}

#[test]
fn rgb_fn_oldlace() {
    assert_eq!(parse("rgb(253, 245, 230)").unwrap(), Rgba::rgb(253, 245, 230));
    assert_eq!(parse("rgba(253,245,230,1)").unwrap().to_hex(), "#fdf5e6");
}

#[test]
fn hex_oldlace() {
    assert_eq!(parse("#FDF5E6").unwrap().to_css(), "rgb(253, 245, 230)");
}

#[test]
fn upper_olive() {
    assert_eq!(parse("  OLIVE ").unwrap(), Rgba::rgb(128, 128, 0));
}

#[test]
fn rgb_fn_olive() {
    assert_eq!(parse("rgb(128, 128, 0)").unwrap(), Rgba::rgb(128, 128, 0));
    assert_eq!(parse("rgba(128,128,0,1)").unwrap().to_hex(), "#808000");
}

#[test]
fn hex_olive() {
    assert_eq!(parse("#808000").unwrap().to_css(), "rgb(128, 128, 0)");
}

#[test]
fn upper_olivedrab() {
    assert_eq!(parse("  OLIVEDRAB ").unwrap(), Rgba::rgb(107, 142, 35));
}

#[test]
fn rgb_fn_olivedrab() {
    assert_eq!(parse("rgb(107, 142, 35)").unwrap(), Rgba::rgb(107, 142, 35));
    assert_eq!(parse("rgba(107,142,35,1)").unwrap().to_hex(), "#6b8e23");
}

#[test]
fn hex_olivedrab() {
    assert_eq!(parse("#6B8E23").unwrap().to_css(), "rgb(107, 142, 35)");
}

#[test]
fn upper_orange() {
    assert_eq!(parse("  ORANGE ").unwrap(), Rgba::rgb(255, 165, 0));
}

#[test]
fn rgb_fn_orange() {
    assert_eq!(parse("rgb(255, 165, 0)").unwrap(), Rgba::rgb(255, 165, 0));
    assert_eq!(parse("rgba(255,165,0,1)").unwrap().to_hex(), "#ffa500");
}

#[test]
fn hex_orange() {
    assert_eq!(parse("#FFA500").unwrap().to_css(), "rgb(255, 165, 0)");
}

#[test]
fn upper_orangered() {
    assert_eq!(parse("  ORANGERED ").unwrap(), Rgba::rgb(255, 69, 0));
}

#[test]
fn rgb_fn_orangered() {
    assert_eq!(parse("rgb(255, 69, 0)").unwrap(), Rgba::rgb(255, 69, 0));
    assert_eq!(parse("rgba(255,69,0,1)").unwrap().to_hex(), "#ff4500");
}

#[test]
fn hex_orangered() {
    assert_eq!(parse("#FF4500").unwrap().to_css(), "rgb(255, 69, 0)");
}

#[test]
fn upper_orchid() {
    assert_eq!(parse("  ORCHID ").unwrap(), Rgba::rgb(218, 112, 214));
}

#[test]
fn rgb_fn_orchid() {
    assert_eq!(parse("rgb(218, 112, 214)").unwrap(), Rgba::rgb(218, 112, 214));
    assert_eq!(parse("rgba(218,112,214,1)").unwrap().to_hex(), "#da70d6");
}

#[test]
fn hex_orchid() {
    assert_eq!(parse("#DA70D6").unwrap().to_css(), "rgb(218, 112, 214)");
}

#[test]
fn upper_palegoldenrod() {
    assert_eq!(parse("  PALEGOLDENROD ").unwrap(), Rgba::rgb(238, 232, 170));
}

#[test]
fn rgb_fn_palegoldenrod() {
    assert_eq!(parse("rgb(238, 232, 170)").unwrap(), Rgba::rgb(238, 232, 170));
    assert_eq!(parse("rgba(238,232,170,1)").unwrap().to_hex(), "#eee8aa");
}

#[test]
fn hex_palegoldenrod() {
    assert_eq!(parse("#EEE8AA").unwrap().to_css(), "rgb(238, 232, 170)");
}

#[test]
fn upper_palegreen() {
    assert_eq!(parse("  PALEGREEN ").unwrap(), Rgba::rgb(152, 251, 152));
}

#[test]
fn rgb_fn_palegreen() {
    assert_eq!(parse("rgb(152, 251, 152)").unwrap(), Rgba::rgb(152, 251, 152));
    assert_eq!(parse("rgba(152,251,152,1)").unwrap().to_hex(), "#98fb98");
}

#[test]
fn hex_palegreen() {
    assert_eq!(parse("#98FB98").unwrap().to_css(), "rgb(152, 251, 152)");
}

#[test]
fn upper_paleturquoise() {
    assert_eq!(parse("  PALETURQUOISE ").unwrap(), Rgba::rgb(175, 238, 238));
}

#[test]
fn rgb_fn_paleturquoise() {
    assert_eq!(parse("rgb(175, 238, 238)").unwrap(), Rgba::rgb(175, 238, 238));
    assert_eq!(parse("rgba(175,238,238,1)").unwrap().to_hex(), "#afeeee");
}

#[test]
fn hex_paleturquoise() {
    assert_eq!(parse("#AFEEEE").unwrap().to_css(), "rgb(175, 238, 238)");
}

#[test]
fn upper_palevioletred() {
    assert_eq!(parse("  PALEVIOLETRED ").unwrap(), Rgba::rgb(219, 112, 147));
}

#[test]
fn rgb_fn_palevioletred() {
    assert_eq!(parse("rgb(219, 112, 147)").unwrap(), Rgba::rgb(219, 112, 147));
    assert_eq!(parse("rgba(219,112,147,1)").unwrap().to_hex(), "#db7093");
}

#[test]
fn hex_palevioletred() {
    assert_eq!(parse("#DB7093").unwrap().to_css(), "rgb(219, 112, 147)");
}

#[test]
fn upper_papayawhip() {
    assert_eq!(parse("  PAPAYAWHIP ").unwrap(), Rgba::rgb(255, 239, 213));
}

#[test]
fn rgb_fn_papayawhip() {
    assert_eq!(parse("rgb(255, 239, 213)").unwrap(), Rgba::rgb(255, 239, 213));
    assert_eq!(parse("rgba(255,239,213,1)").unwrap().to_hex(), "#ffefd5");
}

#[test]
fn hex_papayawhip() {
    assert_eq!(parse("#FFEFD5").unwrap().to_css(), "rgb(255, 239, 213)");
}

#[test]
fn upper_peachpuff() {
    assert_eq!(parse("  PEACHPUFF ").unwrap(), Rgba::rgb(255, 218, 185));
}

#[test]
fn rgb_fn_peachpuff() {
    assert_eq!(parse("rgb(255, 218, 185)").unwrap(), Rgba::rgb(255, 218, 185));
    assert_eq!(parse("rgba(255,218,185,1)").unwrap().to_hex(), "#ffdab9");
}

#[test]
fn hex_peachpuff() {
    assert_eq!(parse("#FFDAB9").unwrap().to_css(), "rgb(255, 218, 185)");
}

#[test]
fn upper_peru() {
    assert_eq!(parse("  PERU ").unwrap(), Rgba::rgb(205, 133, 63));
}

#[test]
fn rgb_fn_peru() {
    assert_eq!(parse("rgb(205, 133, 63)").unwrap(), Rgba::rgb(205, 133, 63));
    assert_eq!(parse("rgba(205,133,63,1)").unwrap().to_hex(), "#cd853f");
}

#[test]
fn hex_peru() {
    assert_eq!(parse("#CD853F").unwrap().to_css(), "rgb(205, 133, 63)");
}

#[test]
fn upper_pink() {
    assert_eq!(parse("  PINK ").unwrap(), Rgba::rgb(255, 192, 203));
}

#[test]
fn rgb_fn_pink() {
    assert_eq!(parse("rgb(255, 192, 203)").unwrap(), Rgba::rgb(255, 192, 203));
    assert_eq!(parse("rgba(255,192,203,1)").unwrap().to_hex(), "#ffc0cb");
}

#[test]
fn hex_pink() {
    assert_eq!(parse("#FFC0CB").unwrap().to_css(), "rgb(255, 192, 203)");
}

#[test]
fn upper_plum() {
    assert_eq!(parse("  PLUM ").unwrap(), Rgba::rgb(221, 160, 221));
}

#[test]
fn rgb_fn_plum() {
    assert_eq!(parse("rgb(221, 160, 221)").unwrap(), Rgba::rgb(221, 160, 221));
    assert_eq!(parse("rgba(221,160,221,1)").unwrap().to_hex(), "#dda0dd");
}

#[test]
fn hex_plum() {
    assert_eq!(parse("#DDA0DD").unwrap().to_css(), "rgb(221, 160, 221)");
}

#[test]
fn upper_powderblue() {
    assert_eq!(parse("  POWDERBLUE ").unwrap(), Rgba::rgb(176, 224, 230));
}

#[test]
fn rgb_fn_powderblue() {
    assert_eq!(parse("rgb(176, 224, 230)").unwrap(), Rgba::rgb(176, 224, 230));
    assert_eq!(parse("rgba(176,224,230,1)").unwrap().to_hex(), "#b0e0e6");
}

#[test]
fn hex_powderblue() {
    assert_eq!(parse("#B0E0E6").unwrap().to_css(), "rgb(176, 224, 230)");
}

#[test]
fn upper_purple() {
    assert_eq!(parse("  PURPLE ").unwrap(), Rgba::rgb(128, 0, 128));
}

#[test]
fn rgb_fn_purple() {
    assert_eq!(parse("rgb(128, 0, 128)").unwrap(), Rgba::rgb(128, 0, 128));
    assert_eq!(parse("rgba(128,0,128,1)").unwrap().to_hex(), "#800080");
}

#[test]
fn hex_purple() {
    assert_eq!(parse("#800080").unwrap().to_css(), "rgb(128, 0, 128)");
}

#[test]
fn upper_rebeccapurple() {
    assert_eq!(parse("  REBECCAPURPLE ").unwrap(), Rgba::rgb(102, 51, 153));
}

#[test]
fn rgb_fn_rebeccapurple() {
    assert_eq!(parse("rgb(102, 51, 153)").unwrap(), Rgba::rgb(102, 51, 153));
    assert_eq!(parse("rgba(102,51,153,1)").unwrap().to_hex(), "#663399");
}

#[test]
fn hex_rebeccapurple() {
    assert_eq!(parse("#663399").unwrap().to_css(), "rgb(102, 51, 153)");
}

#[test]
fn upper_red() {
    assert_eq!(parse("  RED ").unwrap(), Rgba::rgb(255, 0, 0));
}

#[test]
fn rgb_fn_red() {
    assert_eq!(parse("rgb(255, 0, 0)").unwrap(), Rgba::rgb(255, 0, 0));
    assert_eq!(parse("rgba(255,0,0,1)").unwrap().to_hex(), "#ff0000");
}

#[test]
fn hex_red() {
    assert_eq!(parse("#FF0000").unwrap().to_css(), "rgb(255, 0, 0)");
}

#[test]
fn upper_rosybrown() {
    assert_eq!(parse("  ROSYBROWN ").unwrap(), Rgba::rgb(188, 143, 143));
}

#[test]
fn rgb_fn_rosybrown() {
    assert_eq!(parse("rgb(188, 143, 143)").unwrap(), Rgba::rgb(188, 143, 143));
    assert_eq!(parse("rgba(188,143,143,1)").unwrap().to_hex(), "#bc8f8f");
}

#[test]
fn hex_rosybrown() {
    assert_eq!(parse("#BC8F8F").unwrap().to_css(), "rgb(188, 143, 143)");
}

#[test]
fn upper_royalblue() {
    assert_eq!(parse("  ROYALBLUE ").unwrap(), Rgba::rgb(65, 105, 225));
}

#[test]
fn rgb_fn_royalblue() {
    assert_eq!(parse("rgb(65, 105, 225)").unwrap(), Rgba::rgb(65, 105, 225));
    assert_eq!(parse("rgba(65,105,225,1)").unwrap().to_hex(), "#4169e1");
}

#[test]
fn hex_royalblue() {
    assert_eq!(parse("#4169E1").unwrap().to_css(), "rgb(65, 105, 225)");
}

#[test]
fn upper_saddlebrown() {
    assert_eq!(parse("  SADDLEBROWN ").unwrap(), Rgba::rgb(139, 69, 19));
}

#[test]
fn rgb_fn_saddlebrown() {
    assert_eq!(parse("rgb(139, 69, 19)").unwrap(), Rgba::rgb(139, 69, 19));
    assert_eq!(parse("rgba(139,69,19,1)").unwrap().to_hex(), "#8b4513");
}

#[test]
fn hex_saddlebrown() {
    assert_eq!(parse("#8B4513").unwrap().to_css(), "rgb(139, 69, 19)");
}

#[test]
fn upper_salmon() {
    assert_eq!(parse("  SALMON ").unwrap(), Rgba::rgb(250, 128, 114));
}

#[test]
fn rgb_fn_salmon() {
    assert_eq!(parse("rgb(250, 128, 114)").unwrap(), Rgba::rgb(250, 128, 114));
    assert_eq!(parse("rgba(250,128,114,1)").unwrap().to_hex(), "#fa8072");
}

#[test]
fn hex_salmon() {
    assert_eq!(parse("#FA8072").unwrap().to_css(), "rgb(250, 128, 114)");
}

#[test]
fn upper_sandybrown() {
    assert_eq!(parse("  SANDYBROWN ").unwrap(), Rgba::rgb(244, 164, 96));
}

#[test]
fn rgb_fn_sandybrown() {
    assert_eq!(parse("rgb(244, 164, 96)").unwrap(), Rgba::rgb(244, 164, 96));
    assert_eq!(parse("rgba(244,164,96,1)").unwrap().to_hex(), "#f4a460");
}

#[test]
fn hex_sandybrown() {
    assert_eq!(parse("#F4A460").unwrap().to_css(), "rgb(244, 164, 96)");
}

#[test]
fn upper_seagreen() {
    assert_eq!(parse("  SEAGREEN ").unwrap(), Rgba::rgb(46, 139, 87));
}

#[test]
fn rgb_fn_seagreen() {
    assert_eq!(parse("rgb(46, 139, 87)").unwrap(), Rgba::rgb(46, 139, 87));
    assert_eq!(parse("rgba(46,139,87,1)").unwrap().to_hex(), "#2e8b57");
}

#[test]
fn hex_seagreen() {
    assert_eq!(parse("#2E8B57").unwrap().to_css(), "rgb(46, 139, 87)");
}

#[test]
fn upper_seashell() {
    assert_eq!(parse("  SEASHELL ").unwrap(), Rgba::rgb(255, 245, 238));
}

#[test]
fn rgb_fn_seashell() {
    assert_eq!(parse("rgb(255, 245, 238)").unwrap(), Rgba::rgb(255, 245, 238));
    assert_eq!(parse("rgba(255,245,238,1)").unwrap().to_hex(), "#fff5ee");
}

#[test]
fn hex_seashell() {
    assert_eq!(parse("#FFF5EE").unwrap().to_css(), "rgb(255, 245, 238)");
}

#[test]
fn upper_sienna() {
    assert_eq!(parse("  SIENNA ").unwrap(), Rgba::rgb(160, 82, 45));
}

#[test]
fn rgb_fn_sienna() {
    assert_eq!(parse("rgb(160, 82, 45)").unwrap(), Rgba::rgb(160, 82, 45));
    assert_eq!(parse("rgba(160,82,45,1)").unwrap().to_hex(), "#a0522d");
}

#[test]
fn hex_sienna() {
    assert_eq!(parse("#A0522D").unwrap().to_css(), "rgb(160, 82, 45)");
}

#[test]
fn upper_silver() {
    assert_eq!(parse("  SILVER ").unwrap(), Rgba::rgb(192, 192, 192));
}

#[test]
fn rgb_fn_silver() {
    assert_eq!(parse("rgb(192, 192, 192)").unwrap(), Rgba::rgb(192, 192, 192));
    assert_eq!(parse("rgba(192,192,192,1)").unwrap().to_hex(), "#c0c0c0");
}

#[test]
fn hex_silver() {
    assert_eq!(parse("#C0C0C0").unwrap().to_css(), "rgb(192, 192, 192)");
}

#[test]
fn upper_skyblue() {
    assert_eq!(parse("  SKYBLUE ").unwrap(), Rgba::rgb(135, 206, 235));
}

#[test]
fn rgb_fn_skyblue() {
    assert_eq!(parse("rgb(135, 206, 235)").unwrap(), Rgba::rgb(135, 206, 235));
    assert_eq!(parse("rgba(135,206,235,1)").unwrap().to_hex(), "#87ceeb");
}

#[test]
fn hex_skyblue() {
    assert_eq!(parse("#87CEEB").unwrap().to_css(), "rgb(135, 206, 235)");
}

#[test]
fn upper_slateblue() {
    assert_eq!(parse("  SLATEBLUE ").unwrap(), Rgba::rgb(106, 90, 205));
}

#[test]
fn rgb_fn_slateblue() {
    assert_eq!(parse("rgb(106, 90, 205)").unwrap(), Rgba::rgb(106, 90, 205));
    assert_eq!(parse("rgba(106,90,205,1)").unwrap().to_hex(), "#6a5acd");
}

#[test]
fn hex_slateblue() {
    assert_eq!(parse("#6A5ACD").unwrap().to_css(), "rgb(106, 90, 205)");
}

#[test]
fn upper_slategray() {
    assert_eq!(parse("  SLATEGRAY ").unwrap(), Rgba::rgb(112, 128, 144));
}

#[test]
fn rgb_fn_slategray() {
    assert_eq!(parse("rgb(112, 128, 144)").unwrap(), Rgba::rgb(112, 128, 144));
    assert_eq!(parse("rgba(112,128,144,1)").unwrap().to_hex(), "#708090");
}

#[test]
fn hex_slategray() {
    assert_eq!(parse("#708090").unwrap().to_css(), "rgb(112, 128, 144)");
}

#[test]
fn upper_slategrey() {
    assert_eq!(parse("  SLATEGREY ").unwrap(), Rgba::rgb(112, 128, 144));
}

#[test]
fn rgb_fn_slategrey() {
    assert_eq!(parse("rgb(112, 128, 144)").unwrap(), Rgba::rgb(112, 128, 144));
    assert_eq!(parse("rgba(112,128,144,1)").unwrap().to_hex(), "#708090");
}

#[test]
fn hex_slategrey() {
    assert_eq!(parse("#708090").unwrap().to_css(), "rgb(112, 128, 144)");
}

#[test]
fn upper_snow() {
    assert_eq!(parse("  SNOW ").unwrap(), Rgba::rgb(255, 250, 250));
}

#[test]
fn rgb_fn_snow() {
    assert_eq!(parse("rgb(255, 250, 250)").unwrap(), Rgba::rgb(255, 250, 250));
    assert_eq!(parse("rgba(255,250,250,1)").unwrap().to_hex(), "#fffafa");
}

#[test]
fn hex_snow() {
    assert_eq!(parse("#FFFAFA").unwrap().to_css(), "rgb(255, 250, 250)");
}

#[test]
fn upper_springgreen() {
    assert_eq!(parse("  SPRINGGREEN ").unwrap(), Rgba::rgb(0, 255, 127));
}

#[test]
fn rgb_fn_springgreen() {
    assert_eq!(parse("rgb(0, 255, 127)").unwrap(), Rgba::rgb(0, 255, 127));
    assert_eq!(parse("rgba(0,255,127,1)").unwrap().to_hex(), "#00ff7f");
}

#[test]
fn hex_springgreen() {
    assert_eq!(parse("#00FF7F").unwrap().to_css(), "rgb(0, 255, 127)");
}

#[test]
fn upper_steelblue() {
    assert_eq!(parse("  STEELBLUE ").unwrap(), Rgba::rgb(70, 130, 180));
}

#[test]
fn rgb_fn_steelblue() {
    assert_eq!(parse("rgb(70, 130, 180)").unwrap(), Rgba::rgb(70, 130, 180));
    assert_eq!(parse("rgba(70,130,180,1)").unwrap().to_hex(), "#4682b4");
}

#[test]
fn hex_steelblue() {
    assert_eq!(parse("#4682B4").unwrap().to_css(), "rgb(70, 130, 180)");
}

#[test]
fn upper_tan() {
    assert_eq!(parse("  TAN ").unwrap(), Rgba::rgb(210, 180, 140));
}

#[test]
fn rgb_fn_tan() {
    assert_eq!(parse("rgb(210, 180, 140)").unwrap(), Rgba::rgb(210, 180, 140));
    assert_eq!(parse("rgba(210,180,140,1)").unwrap().to_hex(), "#d2b48c");
}

#[test]
fn hex_tan() {
    assert_eq!(parse("#D2B48C").unwrap().to_css(), "rgb(210, 180, 140)");
}

#[test]
fn upper_teal() {
    assert_eq!(parse("  TEAL ").unwrap(), Rgba::rgb(0, 128, 128));
}

#[test]
fn rgb_fn_teal() {
    assert_eq!(parse("rgb(0, 128, 128)").unwrap(), Rgba::rgb(0, 128, 128));
    assert_eq!(parse("rgba(0,128,128,1)").unwrap().to_hex(), "#008080");
}

#[test]
fn hex_teal() {
    assert_eq!(parse("#008080").unwrap().to_css(), "rgb(0, 128, 128)");
}

#[test]
fn upper_thistle() {
    assert_eq!(parse("  THISTLE ").unwrap(), Rgba::rgb(216, 191, 216));
}

#[test]
fn rgb_fn_thistle() {
    assert_eq!(parse("rgb(216, 191, 216)").unwrap(), Rgba::rgb(216, 191, 216));
    assert_eq!(parse("rgba(216,191,216,1)").unwrap().to_hex(), "#d8bfd8");
}

#[test]
fn hex_thistle() {
    assert_eq!(parse("#D8BFD8").unwrap().to_css(), "rgb(216, 191, 216)");
}

#[test]
fn upper_tomato() {
    assert_eq!(parse("  TOMATO ").unwrap(), Rgba::rgb(255, 99, 71));
}

#[test]
fn rgb_fn_tomato() {
    assert_eq!(parse("rgb(255, 99, 71)").unwrap(), Rgba::rgb(255, 99, 71));
    assert_eq!(parse("rgba(255,99,71,1)").unwrap().to_hex(), "#ff6347");
}

#[test]
fn hex_tomato() {
    assert_eq!(parse("#FF6347").unwrap().to_css(), "rgb(255, 99, 71)");
}

#[test]
fn upper_turquoise() {
    assert_eq!(parse("  TURQUOISE ").unwrap(), Rgba::rgb(64, 224, 208));
}

#[test]
fn rgb_fn_turquoise() {
    assert_eq!(parse("rgb(64, 224, 208)").unwrap(), Rgba::rgb(64, 224, 208));
    assert_eq!(parse("rgba(64,224,208,1)").unwrap().to_hex(), "#40e0d0");
}

#[test]
fn hex_turquoise() {
    assert_eq!(parse("#40E0D0").unwrap().to_css(), "rgb(64, 224, 208)");
}

#[test]
fn upper_violet() {
    assert_eq!(parse("  VIOLET ").unwrap(), Rgba::rgb(238, 130, 238));
}

#[test]
fn rgb_fn_violet() {
    assert_eq!(parse("rgb(238, 130, 238)").unwrap(), Rgba::rgb(238, 130, 238));
    assert_eq!(parse("rgba(238,130,238,1)").unwrap().to_hex(), "#ee82ee");
}

#[test]
fn hex_violet() {
    assert_eq!(parse("#EE82EE").unwrap().to_css(), "rgb(238, 130, 238)");
}

#[test]
fn upper_wheat() {
    assert_eq!(parse("  WHEAT ").unwrap(), Rgba::rgb(245, 222, 179));
}

#[test]
fn rgb_fn_wheat() {
    assert_eq!(parse("rgb(245, 222, 179)").unwrap(), Rgba::rgb(245, 222, 179));
    assert_eq!(parse("rgba(245,222,179,1)").unwrap().to_hex(), "#f5deb3");
}

#[test]
fn hex_wheat() {
    assert_eq!(parse("#F5DEB3").unwrap().to_css(), "rgb(245, 222, 179)");
}

#[test]
fn upper_white() {
    assert_eq!(parse("  WHITE ").unwrap(), Rgba::rgb(255, 255, 255));
}

#[test]
fn rgb_fn_white() {
    assert_eq!(parse("rgb(255, 255, 255)").unwrap(), Rgba::rgb(255, 255, 255));
    assert_eq!(parse("rgba(255,255,255,1)").unwrap().to_hex(), "#ffffff");
}

#[test]
fn hex_white() {
    assert_eq!(parse("#FFFFFF").unwrap().to_css(), "rgb(255, 255, 255)");
}

#[test]
fn upper_whitesmoke() {
    assert_eq!(parse("  WHITESMOKE ").unwrap(), Rgba::rgb(245, 245, 245));
}

#[test]
fn rgb_fn_whitesmoke() {
    assert_eq!(parse("rgb(245, 245, 245)").unwrap(), Rgba::rgb(245, 245, 245));
    assert_eq!(parse("rgba(245,245,245,1)").unwrap().to_hex(), "#f5f5f5");
}

#[test]
fn hex_whitesmoke() {
    assert_eq!(parse("#F5F5F5").unwrap().to_css(), "rgb(245, 245, 245)");
}

#[test]
fn upper_yellow() {
    assert_eq!(parse("  YELLOW ").unwrap(), Rgba::rgb(255, 255, 0));
}

#[test]
fn rgb_fn_yellow() {
    assert_eq!(parse("rgb(255, 255, 0)").unwrap(), Rgba::rgb(255, 255, 0));
    assert_eq!(parse("rgba(255,255,0,1)").unwrap().to_hex(), "#ffff00");
}

#[test]
fn hex_yellow() {
    assert_eq!(parse("#FFFF00").unwrap().to_css(), "rgb(255, 255, 0)");
}

#[test]
fn upper_yellowgreen() {
    assert_eq!(parse("  YELLOWGREEN ").unwrap(), Rgba::rgb(154, 205, 50));
}

#[test]
fn rgb_fn_yellowgreen() {
    assert_eq!(parse("rgb(154, 205, 50)").unwrap(), Rgba::rgb(154, 205, 50));
    assert_eq!(parse("rgba(154,205,50,1)").unwrap().to_hex(), "#9acd32");
}

#[test]
fn hex_yellowgreen() {
    assert_eq!(parse("#9ACD32").unwrap().to_css(), "rgb(154, 205, 50)");
}
