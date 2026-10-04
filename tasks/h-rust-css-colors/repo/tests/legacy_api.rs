//! Coverage for the deprecated 0.3 API (generated from the named-color table).

use chroma::legacy;

#[test]
fn legacy_aliceblue() {
    assert_eq!(legacy::named_to_hex("aliceblue").as_deref(), Some("#f0f8ff"));
    assert_eq!(legacy::hex_to_rgb("#f0f8ff"), Some((240, 248, 255)));
    assert_eq!(legacy::rgb_to_hex(240, 248, 255), "#f0f8ff");
}

#[test]
fn legacy_antiquewhite() {
    assert_eq!(legacy::named_to_hex("antiquewhite").as_deref(), Some("#faebd7"));
    assert_eq!(legacy::hex_to_rgb("#faebd7"), Some((250, 235, 215)));
    assert_eq!(legacy::rgb_to_hex(250, 235, 215), "#faebd7");
}

#[test]
fn legacy_aqua() {
    assert_eq!(legacy::named_to_hex("aqua").as_deref(), Some("#00ffff"));
    assert_eq!(legacy::hex_to_rgb("#00ffff"), Some((0, 255, 255)));
    assert_eq!(legacy::rgb_to_hex(0, 255, 255), "#00ffff");
}

#[test]
fn legacy_aquamarine() {
    assert_eq!(legacy::named_to_hex("aquamarine").as_deref(), Some("#7fffd4"));
    assert_eq!(legacy::hex_to_rgb("#7fffd4"), Some((127, 255, 212)));
    assert_eq!(legacy::rgb_to_hex(127, 255, 212), "#7fffd4");
}

#[test]
fn legacy_azure() {
    assert_eq!(legacy::named_to_hex("azure").as_deref(), Some("#f0ffff"));
    assert_eq!(legacy::hex_to_rgb("#f0ffff"), Some((240, 255, 255)));
    assert_eq!(legacy::rgb_to_hex(240, 255, 255), "#f0ffff");
}

#[test]
fn legacy_beige() {
    assert_eq!(legacy::named_to_hex("beige").as_deref(), Some("#f5f5dc"));
    assert_eq!(legacy::hex_to_rgb("#f5f5dc"), Some((245, 245, 220)));
    assert_eq!(legacy::rgb_to_hex(245, 245, 220), "#f5f5dc");
}

#[test]
fn legacy_bisque() {
    assert_eq!(legacy::named_to_hex("bisque").as_deref(), Some("#ffe4c4"));
    assert_eq!(legacy::hex_to_rgb("#ffe4c4"), Some((255, 228, 196)));
    assert_eq!(legacy::rgb_to_hex(255, 228, 196), "#ffe4c4");
}

#[test]
fn legacy_black() {
    assert_eq!(legacy::named_to_hex("black").as_deref(), Some("#000000"));
    assert_eq!(legacy::hex_to_rgb("#000000"), Some((0, 0, 0)));
    assert_eq!(legacy::rgb_to_hex(0, 0, 0), "#000000");
}

#[test]
fn legacy_blanchedalmond() {
    assert_eq!(legacy::named_to_hex("blanchedalmond").as_deref(), Some("#ffebcd"));
    assert_eq!(legacy::hex_to_rgb("#ffebcd"), Some((255, 235, 205)));
    assert_eq!(legacy::rgb_to_hex(255, 235, 205), "#ffebcd");
}

#[test]
fn legacy_blue() {
    assert_eq!(legacy::named_to_hex("blue").as_deref(), Some("#0000ff"));
    assert_eq!(legacy::hex_to_rgb("#0000ff"), Some((0, 0, 255)));
    assert_eq!(legacy::rgb_to_hex(0, 0, 255), "#0000ff");
}

#[test]
fn legacy_blueviolet() {
    assert_eq!(legacy::named_to_hex("blueviolet").as_deref(), Some("#8a2be2"));
    assert_eq!(legacy::hex_to_rgb("#8a2be2"), Some((138, 43, 226)));
    assert_eq!(legacy::rgb_to_hex(138, 43, 226), "#8a2be2");
}

#[test]
fn legacy_brown() {
    assert_eq!(legacy::named_to_hex("brown").as_deref(), Some("#a52a2a"));
    assert_eq!(legacy::hex_to_rgb("#a52a2a"), Some((165, 42, 42)));
    assert_eq!(legacy::rgb_to_hex(165, 42, 42), "#a52a2a");
}

#[test]
fn legacy_burlywood() {
    assert_eq!(legacy::named_to_hex("burlywood").as_deref(), Some("#deb887"));
    assert_eq!(legacy::hex_to_rgb("#deb887"), Some((222, 184, 135)));
    assert_eq!(legacy::rgb_to_hex(222, 184, 135), "#deb887");
}

#[test]
fn legacy_cadetblue() {
    assert_eq!(legacy::named_to_hex("cadetblue").as_deref(), Some("#5f9ea0"));
    assert_eq!(legacy::hex_to_rgb("#5f9ea0"), Some((95, 158, 160)));
    assert_eq!(legacy::rgb_to_hex(95, 158, 160), "#5f9ea0");
}

#[test]
fn legacy_chartreuse() {
    assert_eq!(legacy::named_to_hex("chartreuse").as_deref(), Some("#7fff00"));
    assert_eq!(legacy::hex_to_rgb("#7fff00"), Some((127, 255, 0)));
    assert_eq!(legacy::rgb_to_hex(127, 255, 0), "#7fff00");
}

#[test]
fn legacy_chocolate() {
    assert_eq!(legacy::named_to_hex("chocolate").as_deref(), Some("#d2691e"));
    assert_eq!(legacy::hex_to_rgb("#d2691e"), Some((210, 105, 30)));
    assert_eq!(legacy::rgb_to_hex(210, 105, 30), "#d2691e");
}

#[test]
fn legacy_coral() {
    assert_eq!(legacy::named_to_hex("coral").as_deref(), Some("#ff7f50"));
    assert_eq!(legacy::hex_to_rgb("#ff7f50"), Some((255, 127, 80)));
    assert_eq!(legacy::rgb_to_hex(255, 127, 80), "#ff7f50");
}

#[test]
fn legacy_cornflowerblue() {
    assert_eq!(legacy::named_to_hex("cornflowerblue").as_deref(), Some("#6495ed"));
    assert_eq!(legacy::hex_to_rgb("#6495ed"), Some((100, 149, 237)));
    assert_eq!(legacy::rgb_to_hex(100, 149, 237), "#6495ed");
}

#[test]
fn legacy_cornsilk() {
    assert_eq!(legacy::named_to_hex("cornsilk").as_deref(), Some("#fff8dc"));
    assert_eq!(legacy::hex_to_rgb("#fff8dc"), Some((255, 248, 220)));
    assert_eq!(legacy::rgb_to_hex(255, 248, 220), "#fff8dc");
}

#[test]
fn legacy_crimson() {
    assert_eq!(legacy::named_to_hex("crimson").as_deref(), Some("#dc143c"));
    assert_eq!(legacy::hex_to_rgb("#dc143c"), Some((220, 20, 60)));
    assert_eq!(legacy::rgb_to_hex(220, 20, 60), "#dc143c");
}

#[test]
fn legacy_cyan() {
    assert_eq!(legacy::named_to_hex("cyan").as_deref(), Some("#00ffff"));
    assert_eq!(legacy::hex_to_rgb("#00ffff"), Some((0, 255, 255)));
    assert_eq!(legacy::rgb_to_hex(0, 255, 255), "#00ffff");
}

#[test]
fn legacy_darkblue() {
    assert_eq!(legacy::named_to_hex("darkblue").as_deref(), Some("#00008b"));
    assert_eq!(legacy::hex_to_rgb("#00008b"), Some((0, 0, 139)));
    assert_eq!(legacy::rgb_to_hex(0, 0, 139), "#00008b");
}

#[test]
fn legacy_darkcyan() {
    assert_eq!(legacy::named_to_hex("darkcyan").as_deref(), Some("#008b8b"));
    assert_eq!(legacy::hex_to_rgb("#008b8b"), Some((0, 139, 139)));
    assert_eq!(legacy::rgb_to_hex(0, 139, 139), "#008b8b");
}

#[test]
fn legacy_darkgoldenrod() {
    assert_eq!(legacy::named_to_hex("darkgoldenrod").as_deref(), Some("#b8860b"));
    assert_eq!(legacy::hex_to_rgb("#b8860b"), Some((184, 134, 11)));
    assert_eq!(legacy::rgb_to_hex(184, 134, 11), "#b8860b");
}

#[test]
fn legacy_darkgray() {
    assert_eq!(legacy::named_to_hex("darkgray").as_deref(), Some("#a9a9a9"));
    assert_eq!(legacy::hex_to_rgb("#a9a9a9"), Some((169, 169, 169)));
    assert_eq!(legacy::rgb_to_hex(169, 169, 169), "#a9a9a9");
}

#[test]
fn legacy_darkgreen() {
    assert_eq!(legacy::named_to_hex("darkgreen").as_deref(), Some("#006400"));
    assert_eq!(legacy::hex_to_rgb("#006400"), Some((0, 100, 0)));
    assert_eq!(legacy::rgb_to_hex(0, 100, 0), "#006400");
}

#[test]
fn legacy_darkgrey() {
    assert_eq!(legacy::named_to_hex("darkgrey").as_deref(), Some("#a9a9a9"));
    assert_eq!(legacy::hex_to_rgb("#a9a9a9"), Some((169, 169, 169)));
    assert_eq!(legacy::rgb_to_hex(169, 169, 169), "#a9a9a9");
}

#[test]
fn legacy_darkkhaki() {
    assert_eq!(legacy::named_to_hex("darkkhaki").as_deref(), Some("#bdb76b"));
    assert_eq!(legacy::hex_to_rgb("#bdb76b"), Some((189, 183, 107)));
    assert_eq!(legacy::rgb_to_hex(189, 183, 107), "#bdb76b");
}

#[test]
fn legacy_darkmagenta() {
    assert_eq!(legacy::named_to_hex("darkmagenta").as_deref(), Some("#8b008b"));
    assert_eq!(legacy::hex_to_rgb("#8b008b"), Some((139, 0, 139)));
    assert_eq!(legacy::rgb_to_hex(139, 0, 139), "#8b008b");
}

#[test]
fn legacy_darkolivegreen() {
    assert_eq!(legacy::named_to_hex("darkolivegreen").as_deref(), Some("#556b2f"));
    assert_eq!(legacy::hex_to_rgb("#556b2f"), Some((85, 107, 47)));
    assert_eq!(legacy::rgb_to_hex(85, 107, 47), "#556b2f");
}

#[test]
fn legacy_darkorange() {
    assert_eq!(legacy::named_to_hex("darkorange").as_deref(), Some("#ff8c00"));
    assert_eq!(legacy::hex_to_rgb("#ff8c00"), Some((255, 140, 0)));
    assert_eq!(legacy::rgb_to_hex(255, 140, 0), "#ff8c00");
}

#[test]
fn legacy_darkorchid() {
    assert_eq!(legacy::named_to_hex("darkorchid").as_deref(), Some("#9932cc"));
    assert_eq!(legacy::hex_to_rgb("#9932cc"), Some((153, 50, 204)));
    assert_eq!(legacy::rgb_to_hex(153, 50, 204), "#9932cc");
}

#[test]
fn legacy_darkred() {
    assert_eq!(legacy::named_to_hex("darkred").as_deref(), Some("#8b0000"));
    assert_eq!(legacy::hex_to_rgb("#8b0000"), Some((139, 0, 0)));
    assert_eq!(legacy::rgb_to_hex(139, 0, 0), "#8b0000");
}

#[test]
fn legacy_darksalmon() {
    assert_eq!(legacy::named_to_hex("darksalmon").as_deref(), Some("#e9967a"));
    assert_eq!(legacy::hex_to_rgb("#e9967a"), Some((233, 150, 122)));
    assert_eq!(legacy::rgb_to_hex(233, 150, 122), "#e9967a");
}

#[test]
fn legacy_darkseagreen() {
    assert_eq!(legacy::named_to_hex("darkseagreen").as_deref(), Some("#8fbc8f"));
    assert_eq!(legacy::hex_to_rgb("#8fbc8f"), Some((143, 188, 143)));
    assert_eq!(legacy::rgb_to_hex(143, 188, 143), "#8fbc8f");
}

#[test]
fn legacy_darkslateblue() {
    assert_eq!(legacy::named_to_hex("darkslateblue").as_deref(), Some("#483d8b"));
    assert_eq!(legacy::hex_to_rgb("#483d8b"), Some((72, 61, 139)));
    assert_eq!(legacy::rgb_to_hex(72, 61, 139), "#483d8b");
}

#[test]
fn legacy_darkslategray() {
    assert_eq!(legacy::named_to_hex("darkslategray").as_deref(), Some("#2f4f4f"));
    assert_eq!(legacy::hex_to_rgb("#2f4f4f"), Some((47, 79, 79)));
    assert_eq!(legacy::rgb_to_hex(47, 79, 79), "#2f4f4f");
}

#[test]
fn legacy_darkslategrey() {
    assert_eq!(legacy::named_to_hex("darkslategrey").as_deref(), Some("#2f4f4f"));
    assert_eq!(legacy::hex_to_rgb("#2f4f4f"), Some((47, 79, 79)));
    assert_eq!(legacy::rgb_to_hex(47, 79, 79), "#2f4f4f");
}

#[test]
fn legacy_darkturquoise() {
    assert_eq!(legacy::named_to_hex("darkturquoise").as_deref(), Some("#00ced1"));
    assert_eq!(legacy::hex_to_rgb("#00ced1"), Some((0, 206, 209)));
    assert_eq!(legacy::rgb_to_hex(0, 206, 209), "#00ced1");
}

#[test]
fn legacy_darkviolet() {
    assert_eq!(legacy::named_to_hex("darkviolet").as_deref(), Some("#9400d3"));
    assert_eq!(legacy::hex_to_rgb("#9400d3"), Some((148, 0, 211)));
    assert_eq!(legacy::rgb_to_hex(148, 0, 211), "#9400d3");
}

#[test]
fn legacy_deeppink() {
    assert_eq!(legacy::named_to_hex("deeppink").as_deref(), Some("#ff1493"));
    assert_eq!(legacy::hex_to_rgb("#ff1493"), Some((255, 20, 147)));
    assert_eq!(legacy::rgb_to_hex(255, 20, 147), "#ff1493");
}

#[test]
fn legacy_deepskyblue() {
    assert_eq!(legacy::named_to_hex("deepskyblue").as_deref(), Some("#00bfff"));
    assert_eq!(legacy::hex_to_rgb("#00bfff"), Some((0, 191, 255)));
    assert_eq!(legacy::rgb_to_hex(0, 191, 255), "#00bfff");
}

#[test]
fn legacy_dimgray() {
    assert_eq!(legacy::named_to_hex("dimgray").as_deref(), Some("#696969"));
    assert_eq!(legacy::hex_to_rgb("#696969"), Some((105, 105, 105)));
    assert_eq!(legacy::rgb_to_hex(105, 105, 105), "#696969");
}

#[test]
fn legacy_dimgrey() {
    assert_eq!(legacy::named_to_hex("dimgrey").as_deref(), Some("#696969"));
    assert_eq!(legacy::hex_to_rgb("#696969"), Some((105, 105, 105)));
    assert_eq!(legacy::rgb_to_hex(105, 105, 105), "#696969");
}

#[test]
fn legacy_dodgerblue() {
    assert_eq!(legacy::named_to_hex("dodgerblue").as_deref(), Some("#1e90ff"));
    assert_eq!(legacy::hex_to_rgb("#1e90ff"), Some((30, 144, 255)));
    assert_eq!(legacy::rgb_to_hex(30, 144, 255), "#1e90ff");
}

#[test]
fn legacy_firebrick() {
    assert_eq!(legacy::named_to_hex("firebrick").as_deref(), Some("#b22222"));
    assert_eq!(legacy::hex_to_rgb("#b22222"), Some((178, 34, 34)));
    assert_eq!(legacy::rgb_to_hex(178, 34, 34), "#b22222");
}

#[test]
fn legacy_floralwhite() {
    assert_eq!(legacy::named_to_hex("floralwhite").as_deref(), Some("#fffaf0"));
    assert_eq!(legacy::hex_to_rgb("#fffaf0"), Some((255, 250, 240)));
    assert_eq!(legacy::rgb_to_hex(255, 250, 240), "#fffaf0");
}

#[test]
fn legacy_forestgreen() {
    assert_eq!(legacy::named_to_hex("forestgreen").as_deref(), Some("#228b22"));
    assert_eq!(legacy::hex_to_rgb("#228b22"), Some((34, 139, 34)));
    assert_eq!(legacy::rgb_to_hex(34, 139, 34), "#228b22");
}

#[test]
fn legacy_fuchsia() {
    assert_eq!(legacy::named_to_hex("fuchsia").as_deref(), Some("#ff00ff"));
    assert_eq!(legacy::hex_to_rgb("#ff00ff"), Some((255, 0, 255)));
    assert_eq!(legacy::rgb_to_hex(255, 0, 255), "#ff00ff");
}

#[test]
fn legacy_gainsboro() {
    assert_eq!(legacy::named_to_hex("gainsboro").as_deref(), Some("#dcdcdc"));
    assert_eq!(legacy::hex_to_rgb("#dcdcdc"), Some((220, 220, 220)));
    assert_eq!(legacy::rgb_to_hex(220, 220, 220), "#dcdcdc");
}

#[test]
fn legacy_ghostwhite() {
    assert_eq!(legacy::named_to_hex("ghostwhite").as_deref(), Some("#f8f8ff"));
    assert_eq!(legacy::hex_to_rgb("#f8f8ff"), Some((248, 248, 255)));
    assert_eq!(legacy::rgb_to_hex(248, 248, 255), "#f8f8ff");
}

#[test]
fn legacy_gold() {
    assert_eq!(legacy::named_to_hex("gold").as_deref(), Some("#ffd700"));
    assert_eq!(legacy::hex_to_rgb("#ffd700"), Some((255, 215, 0)));
    assert_eq!(legacy::rgb_to_hex(255, 215, 0), "#ffd700");
}

#[test]
fn legacy_goldenrod() {
    assert_eq!(legacy::named_to_hex("goldenrod").as_deref(), Some("#daa520"));
    assert_eq!(legacy::hex_to_rgb("#daa520"), Some((218, 165, 32)));
    assert_eq!(legacy::rgb_to_hex(218, 165, 32), "#daa520");
}

#[test]
fn legacy_gray() {
    assert_eq!(legacy::named_to_hex("gray").as_deref(), Some("#808080"));
    assert_eq!(legacy::hex_to_rgb("#808080"), Some((128, 128, 128)));
    assert_eq!(legacy::rgb_to_hex(128, 128, 128), "#808080");
}

#[test]
fn legacy_green() {
    assert_eq!(legacy::named_to_hex("green").as_deref(), Some("#008000"));
    assert_eq!(legacy::hex_to_rgb("#008000"), Some((0, 128, 0)));
    assert_eq!(legacy::rgb_to_hex(0, 128, 0), "#008000");
}

#[test]
fn legacy_greenyellow() {
    assert_eq!(legacy::named_to_hex("greenyellow").as_deref(), Some("#adff2f"));
    assert_eq!(legacy::hex_to_rgb("#adff2f"), Some((173, 255, 47)));
    assert_eq!(legacy::rgb_to_hex(173, 255, 47), "#adff2f");
}

#[test]
fn legacy_grey() {
    assert_eq!(legacy::named_to_hex("grey").as_deref(), Some("#808080"));
    assert_eq!(legacy::hex_to_rgb("#808080"), Some((128, 128, 128)));
    assert_eq!(legacy::rgb_to_hex(128, 128, 128), "#808080");
}

#[test]
fn legacy_honeydew() {
    assert_eq!(legacy::named_to_hex("honeydew").as_deref(), Some("#f0fff0"));
    assert_eq!(legacy::hex_to_rgb("#f0fff0"), Some((240, 255, 240)));
    assert_eq!(legacy::rgb_to_hex(240, 255, 240), "#f0fff0");
}

#[test]
fn legacy_hotpink() {
    assert_eq!(legacy::named_to_hex("hotpink").as_deref(), Some("#ff69b4"));
    assert_eq!(legacy::hex_to_rgb("#ff69b4"), Some((255, 105, 180)));
    assert_eq!(legacy::rgb_to_hex(255, 105, 180), "#ff69b4");
}

#[test]
fn legacy_indianred() {
    assert_eq!(legacy::named_to_hex("indianred").as_deref(), Some("#cd5c5c"));
    assert_eq!(legacy::hex_to_rgb("#cd5c5c"), Some((205, 92, 92)));
    assert_eq!(legacy::rgb_to_hex(205, 92, 92), "#cd5c5c");
}

#[test]
fn legacy_indigo() {
    assert_eq!(legacy::named_to_hex("indigo").as_deref(), Some("#4b0082"));
    assert_eq!(legacy::hex_to_rgb("#4b0082"), Some((75, 0, 130)));
    assert_eq!(legacy::rgb_to_hex(75, 0, 130), "#4b0082");
}

#[test]
fn legacy_ivory() {
    assert_eq!(legacy::named_to_hex("ivory").as_deref(), Some("#fffff0"));
    assert_eq!(legacy::hex_to_rgb("#fffff0"), Some((255, 255, 240)));
    assert_eq!(legacy::rgb_to_hex(255, 255, 240), "#fffff0");
}

#[test]
fn legacy_khaki() {
    assert_eq!(legacy::named_to_hex("khaki").as_deref(), Some("#f0e68c"));
    assert_eq!(legacy::hex_to_rgb("#f0e68c"), Some((240, 230, 140)));
    assert_eq!(legacy::rgb_to_hex(240, 230, 140), "#f0e68c");
}

#[test]
fn legacy_lavender() {
    assert_eq!(legacy::named_to_hex("lavender").as_deref(), Some("#e6e6fa"));
    assert_eq!(legacy::hex_to_rgb("#e6e6fa"), Some((230, 230, 250)));
    assert_eq!(legacy::rgb_to_hex(230, 230, 250), "#e6e6fa");
}

#[test]
fn legacy_lavenderblush() {
    assert_eq!(legacy::named_to_hex("lavenderblush").as_deref(), Some("#fff0f5"));
    assert_eq!(legacy::hex_to_rgb("#fff0f5"), Some((255, 240, 245)));
    assert_eq!(legacy::rgb_to_hex(255, 240, 245), "#fff0f5");
}

#[test]
fn legacy_lawngreen() {
    assert_eq!(legacy::named_to_hex("lawngreen").as_deref(), Some("#7cfc00"));
    assert_eq!(legacy::hex_to_rgb("#7cfc00"), Some((124, 252, 0)));
    assert_eq!(legacy::rgb_to_hex(124, 252, 0), "#7cfc00");
}

#[test]
fn legacy_lemonchiffon() {
    assert_eq!(legacy::named_to_hex("lemonchiffon").as_deref(), Some("#fffacd"));
    assert_eq!(legacy::hex_to_rgb("#fffacd"), Some((255, 250, 205)));
    assert_eq!(legacy::rgb_to_hex(255, 250, 205), "#fffacd");
}

#[test]
fn legacy_lightblue() {
    assert_eq!(legacy::named_to_hex("lightblue").as_deref(), Some("#add8e6"));
    assert_eq!(legacy::hex_to_rgb("#add8e6"), Some((173, 216, 230)));
    assert_eq!(legacy::rgb_to_hex(173, 216, 230), "#add8e6");
}

#[test]
fn legacy_lightcoral() {
    assert_eq!(legacy::named_to_hex("lightcoral").as_deref(), Some("#f08080"));
    assert_eq!(legacy::hex_to_rgb("#f08080"), Some((240, 128, 128)));
    assert_eq!(legacy::rgb_to_hex(240, 128, 128), "#f08080");
}

#[test]
fn legacy_lightcyan() {
    assert_eq!(legacy::named_to_hex("lightcyan").as_deref(), Some("#e0ffff"));
    assert_eq!(legacy::hex_to_rgb("#e0ffff"), Some((224, 255, 255)));
    assert_eq!(legacy::rgb_to_hex(224, 255, 255), "#e0ffff");
}

#[test]
fn legacy_lightgoldenrodyellow() {
    assert_eq!(legacy::named_to_hex("lightgoldenrodyellow").as_deref(), Some("#fafad2"));
    assert_eq!(legacy::hex_to_rgb("#fafad2"), Some((250, 250, 210)));
    assert_eq!(legacy::rgb_to_hex(250, 250, 210), "#fafad2");
}

#[test]
fn legacy_lightgray() {
    assert_eq!(legacy::named_to_hex("lightgray").as_deref(), Some("#d3d3d3"));
    assert_eq!(legacy::hex_to_rgb("#d3d3d3"), Some((211, 211, 211)));
    assert_eq!(legacy::rgb_to_hex(211, 211, 211), "#d3d3d3");
}

#[test]
fn legacy_lightgreen() {
    assert_eq!(legacy::named_to_hex("lightgreen").as_deref(), Some("#90ee90"));
    assert_eq!(legacy::hex_to_rgb("#90ee90"), Some((144, 238, 144)));
    assert_eq!(legacy::rgb_to_hex(144, 238, 144), "#90ee90");
}

#[test]
fn legacy_lightgrey() {
    assert_eq!(legacy::named_to_hex("lightgrey").as_deref(), Some("#d3d3d3"));
    assert_eq!(legacy::hex_to_rgb("#d3d3d3"), Some((211, 211, 211)));
    assert_eq!(legacy::rgb_to_hex(211, 211, 211), "#d3d3d3");
}

#[test]
fn legacy_lightpink() {
    assert_eq!(legacy::named_to_hex("lightpink").as_deref(), Some("#ffb6c1"));
    assert_eq!(legacy::hex_to_rgb("#ffb6c1"), Some((255, 182, 193)));
    assert_eq!(legacy::rgb_to_hex(255, 182, 193), "#ffb6c1");
}

#[test]
fn legacy_lightsalmon() {
    assert_eq!(legacy::named_to_hex("lightsalmon").as_deref(), Some("#ffa07a"));
    assert_eq!(legacy::hex_to_rgb("#ffa07a"), Some((255, 160, 122)));
    assert_eq!(legacy::rgb_to_hex(255, 160, 122), "#ffa07a");
}

#[test]
fn legacy_lightseagreen() {
    assert_eq!(legacy::named_to_hex("lightseagreen").as_deref(), Some("#20b2aa"));
    assert_eq!(legacy::hex_to_rgb("#20b2aa"), Some((32, 178, 170)));
    assert_eq!(legacy::rgb_to_hex(32, 178, 170), "#20b2aa");
}

#[test]
fn legacy_lightskyblue() {
    assert_eq!(legacy::named_to_hex("lightskyblue").as_deref(), Some("#87cefa"));
    assert_eq!(legacy::hex_to_rgb("#87cefa"), Some((135, 206, 250)));
    assert_eq!(legacy::rgb_to_hex(135, 206, 250), "#87cefa");
}

#[test]
fn legacy_lightslategray() {
    assert_eq!(legacy::named_to_hex("lightslategray").as_deref(), Some("#778899"));
    assert_eq!(legacy::hex_to_rgb("#778899"), Some((119, 136, 153)));
    assert_eq!(legacy::rgb_to_hex(119, 136, 153), "#778899");
}

#[test]
fn legacy_lightslategrey() {
    assert_eq!(legacy::named_to_hex("lightslategrey").as_deref(), Some("#778899"));
    assert_eq!(legacy::hex_to_rgb("#778899"), Some((119, 136, 153)));
    assert_eq!(legacy::rgb_to_hex(119, 136, 153), "#778899");
}

#[test]
fn legacy_lightsteelblue() {
    assert_eq!(legacy::named_to_hex("lightsteelblue").as_deref(), Some("#b0c4de"));
    assert_eq!(legacy::hex_to_rgb("#b0c4de"), Some((176, 196, 222)));
    assert_eq!(legacy::rgb_to_hex(176, 196, 222), "#b0c4de");
}

#[test]
fn legacy_lightyellow() {
    assert_eq!(legacy::named_to_hex("lightyellow").as_deref(), Some("#ffffe0"));
    assert_eq!(legacy::hex_to_rgb("#ffffe0"), Some((255, 255, 224)));
    assert_eq!(legacy::rgb_to_hex(255, 255, 224), "#ffffe0");
}

#[test]
fn legacy_lime() {
    assert_eq!(legacy::named_to_hex("lime").as_deref(), Some("#00ff00"));
    assert_eq!(legacy::hex_to_rgb("#00ff00"), Some((0, 255, 0)));
    assert_eq!(legacy::rgb_to_hex(0, 255, 0), "#00ff00");
}

#[test]
fn legacy_limegreen() {
    assert_eq!(legacy::named_to_hex("limegreen").as_deref(), Some("#32cd32"));
    assert_eq!(legacy::hex_to_rgb("#32cd32"), Some((50, 205, 50)));
    assert_eq!(legacy::rgb_to_hex(50, 205, 50), "#32cd32");
}

#[test]
fn legacy_linen() {
    assert_eq!(legacy::named_to_hex("linen").as_deref(), Some("#faf0e6"));
    assert_eq!(legacy::hex_to_rgb("#faf0e6"), Some((250, 240, 230)));
    assert_eq!(legacy::rgb_to_hex(250, 240, 230), "#faf0e6");
}

#[test]
fn legacy_magenta() {
    assert_eq!(legacy::named_to_hex("magenta").as_deref(), Some("#ff00ff"));
    assert_eq!(legacy::hex_to_rgb("#ff00ff"), Some((255, 0, 255)));
    assert_eq!(legacy::rgb_to_hex(255, 0, 255), "#ff00ff");
}

#[test]
fn legacy_maroon() {
    assert_eq!(legacy::named_to_hex("maroon").as_deref(), Some("#800000"));
    assert_eq!(legacy::hex_to_rgb("#800000"), Some((128, 0, 0)));
    assert_eq!(legacy::rgb_to_hex(128, 0, 0), "#800000");
}

#[test]
fn legacy_mediumaquamarine() {
    assert_eq!(legacy::named_to_hex("mediumaquamarine").as_deref(), Some("#66cdaa"));
    assert_eq!(legacy::hex_to_rgb("#66cdaa"), Some((102, 205, 170)));
    assert_eq!(legacy::rgb_to_hex(102, 205, 170), "#66cdaa");
}

#[test]
fn legacy_mediumblue() {
    assert_eq!(legacy::named_to_hex("mediumblue").as_deref(), Some("#0000cd"));
    assert_eq!(legacy::hex_to_rgb("#0000cd"), Some((0, 0, 205)));
    assert_eq!(legacy::rgb_to_hex(0, 0, 205), "#0000cd");
}

#[test]
fn legacy_mediumorchid() {
    assert_eq!(legacy::named_to_hex("mediumorchid").as_deref(), Some("#ba55d3"));
    assert_eq!(legacy::hex_to_rgb("#ba55d3"), Some((186, 85, 211)));
    assert_eq!(legacy::rgb_to_hex(186, 85, 211), "#ba55d3");
}

#[test]
fn legacy_mediumpurple() {
    assert_eq!(legacy::named_to_hex("mediumpurple").as_deref(), Some("#9370db"));
    assert_eq!(legacy::hex_to_rgb("#9370db"), Some((147, 112, 219)));
    assert_eq!(legacy::rgb_to_hex(147, 112, 219), "#9370db");
}

#[test]
fn legacy_mediumseagreen() {
    assert_eq!(legacy::named_to_hex("mediumseagreen").as_deref(), Some("#3cb371"));
    assert_eq!(legacy::hex_to_rgb("#3cb371"), Some((60, 179, 113)));
    assert_eq!(legacy::rgb_to_hex(60, 179, 113), "#3cb371");
}

#[test]
fn legacy_mediumslateblue() {
    assert_eq!(legacy::named_to_hex("mediumslateblue").as_deref(), Some("#7b68ee"));
    assert_eq!(legacy::hex_to_rgb("#7b68ee"), Some((123, 104, 238)));
    assert_eq!(legacy::rgb_to_hex(123, 104, 238), "#7b68ee");
}

#[test]
fn legacy_mediumspringgreen() {
    assert_eq!(legacy::named_to_hex("mediumspringgreen").as_deref(), Some("#00fa9a"));
    assert_eq!(legacy::hex_to_rgb("#00fa9a"), Some((0, 250, 154)));
    assert_eq!(legacy::rgb_to_hex(0, 250, 154), "#00fa9a");
}

#[test]
fn legacy_mediumturquoise() {
    assert_eq!(legacy::named_to_hex("mediumturquoise").as_deref(), Some("#48d1cc"));
    assert_eq!(legacy::hex_to_rgb("#48d1cc"), Some((72, 209, 204)));
    assert_eq!(legacy::rgb_to_hex(72, 209, 204), "#48d1cc");
}

#[test]
fn legacy_mediumvioletred() {
    assert_eq!(legacy::named_to_hex("mediumvioletred").as_deref(), Some("#c71585"));
    assert_eq!(legacy::hex_to_rgb("#c71585"), Some((199, 21, 133)));
    assert_eq!(legacy::rgb_to_hex(199, 21, 133), "#c71585");
}

#[test]
fn legacy_midnightblue() {
    assert_eq!(legacy::named_to_hex("midnightblue").as_deref(), Some("#191970"));
    assert_eq!(legacy::hex_to_rgb("#191970"), Some((25, 25, 112)));
    assert_eq!(legacy::rgb_to_hex(25, 25, 112), "#191970");
}

#[test]
fn legacy_mintcream() {
    assert_eq!(legacy::named_to_hex("mintcream").as_deref(), Some("#f5fffa"));
    assert_eq!(legacy::hex_to_rgb("#f5fffa"), Some((245, 255, 250)));
    assert_eq!(legacy::rgb_to_hex(245, 255, 250), "#f5fffa");
}

#[test]
fn legacy_mistyrose() {
    assert_eq!(legacy::named_to_hex("mistyrose").as_deref(), Some("#ffe4e1"));
    assert_eq!(legacy::hex_to_rgb("#ffe4e1"), Some((255, 228, 225)));
    assert_eq!(legacy::rgb_to_hex(255, 228, 225), "#ffe4e1");
}

#[test]
fn legacy_moccasin() {
    assert_eq!(legacy::named_to_hex("moccasin").as_deref(), Some("#ffe4b5"));
    assert_eq!(legacy::hex_to_rgb("#ffe4b5"), Some((255, 228, 181)));
    assert_eq!(legacy::rgb_to_hex(255, 228, 181), "#ffe4b5");
}

#[test]
fn legacy_navajowhite() {
    assert_eq!(legacy::named_to_hex("navajowhite").as_deref(), Some("#ffdead"));
    assert_eq!(legacy::hex_to_rgb("#ffdead"), Some((255, 222, 173)));
    assert_eq!(legacy::rgb_to_hex(255, 222, 173), "#ffdead");
}

#[test]
fn legacy_navy() {
    assert_eq!(legacy::named_to_hex("navy").as_deref(), Some("#000080"));
    assert_eq!(legacy::hex_to_rgb("#000080"), Some((0, 0, 128)));
    assert_eq!(legacy::rgb_to_hex(0, 0, 128), "#000080");
}

#[test]
fn legacy_oldlace() {
    assert_eq!(legacy::named_to_hex("oldlace").as_deref(), Some("#fdf5e6"));
    assert_eq!(legacy::hex_to_rgb("#fdf5e6"), Some((253, 245, 230)));
    assert_eq!(legacy::rgb_to_hex(253, 245, 230), "#fdf5e6");
}

#[test]
fn legacy_olive() {
    assert_eq!(legacy::named_to_hex("olive").as_deref(), Some("#808000"));
    assert_eq!(legacy::hex_to_rgb("#808000"), Some((128, 128, 0)));
    assert_eq!(legacy::rgb_to_hex(128, 128, 0), "#808000");
}

#[test]
fn legacy_olivedrab() {
    assert_eq!(legacy::named_to_hex("olivedrab").as_deref(), Some("#6b8e23"));
    assert_eq!(legacy::hex_to_rgb("#6b8e23"), Some((107, 142, 35)));
    assert_eq!(legacy::rgb_to_hex(107, 142, 35), "#6b8e23");
}

#[test]
fn legacy_orange() {
    assert_eq!(legacy::named_to_hex("orange").as_deref(), Some("#ffa500"));
    assert_eq!(legacy::hex_to_rgb("#ffa500"), Some((255, 165, 0)));
    assert_eq!(legacy::rgb_to_hex(255, 165, 0), "#ffa500");
}

#[test]
fn legacy_orangered() {
    assert_eq!(legacy::named_to_hex("orangered").as_deref(), Some("#ff4500"));
    assert_eq!(legacy::hex_to_rgb("#ff4500"), Some((255, 69, 0)));
    assert_eq!(legacy::rgb_to_hex(255, 69, 0), "#ff4500");
}

#[test]
fn legacy_orchid() {
    assert_eq!(legacy::named_to_hex("orchid").as_deref(), Some("#da70d6"));
    assert_eq!(legacy::hex_to_rgb("#da70d6"), Some((218, 112, 214)));
    assert_eq!(legacy::rgb_to_hex(218, 112, 214), "#da70d6");
}

#[test]
fn legacy_palegoldenrod() {
    assert_eq!(legacy::named_to_hex("palegoldenrod").as_deref(), Some("#eee8aa"));
    assert_eq!(legacy::hex_to_rgb("#eee8aa"), Some((238, 232, 170)));
    assert_eq!(legacy::rgb_to_hex(238, 232, 170), "#eee8aa");
}

#[test]
fn legacy_palegreen() {
    assert_eq!(legacy::named_to_hex("palegreen").as_deref(), Some("#98fb98"));
    assert_eq!(legacy::hex_to_rgb("#98fb98"), Some((152, 251, 152)));
    assert_eq!(legacy::rgb_to_hex(152, 251, 152), "#98fb98");
}

#[test]
fn legacy_paleturquoise() {
    assert_eq!(legacy::named_to_hex("paleturquoise").as_deref(), Some("#afeeee"));
    assert_eq!(legacy::hex_to_rgb("#afeeee"), Some((175, 238, 238)));
    assert_eq!(legacy::rgb_to_hex(175, 238, 238), "#afeeee");
}

#[test]
fn legacy_palevioletred() {
    assert_eq!(legacy::named_to_hex("palevioletred").as_deref(), Some("#db7093"));
    assert_eq!(legacy::hex_to_rgb("#db7093"), Some((219, 112, 147)));
    assert_eq!(legacy::rgb_to_hex(219, 112, 147), "#db7093");
}

#[test]
fn legacy_papayawhip() {
    assert_eq!(legacy::named_to_hex("papayawhip").as_deref(), Some("#ffefd5"));
    assert_eq!(legacy::hex_to_rgb("#ffefd5"), Some((255, 239, 213)));
    assert_eq!(legacy::rgb_to_hex(255, 239, 213), "#ffefd5");
}

#[test]
fn legacy_peachpuff() {
    assert_eq!(legacy::named_to_hex("peachpuff").as_deref(), Some("#ffdab9"));
    assert_eq!(legacy::hex_to_rgb("#ffdab9"), Some((255, 218, 185)));
    assert_eq!(legacy::rgb_to_hex(255, 218, 185), "#ffdab9");
}

#[test]
fn legacy_peru() {
    assert_eq!(legacy::named_to_hex("peru").as_deref(), Some("#cd853f"));
    assert_eq!(legacy::hex_to_rgb("#cd853f"), Some((205, 133, 63)));
    assert_eq!(legacy::rgb_to_hex(205, 133, 63), "#cd853f");
}

#[test]
fn legacy_pink() {
    assert_eq!(legacy::named_to_hex("pink").as_deref(), Some("#ffc0cb"));
    assert_eq!(legacy::hex_to_rgb("#ffc0cb"), Some((255, 192, 203)));
    assert_eq!(legacy::rgb_to_hex(255, 192, 203), "#ffc0cb");
}

#[test]
fn legacy_plum() {
    assert_eq!(legacy::named_to_hex("plum").as_deref(), Some("#dda0dd"));
    assert_eq!(legacy::hex_to_rgb("#dda0dd"), Some((221, 160, 221)));
    assert_eq!(legacy::rgb_to_hex(221, 160, 221), "#dda0dd");
}

#[test]
fn legacy_powderblue() {
    assert_eq!(legacy::named_to_hex("powderblue").as_deref(), Some("#b0e0e6"));
    assert_eq!(legacy::hex_to_rgb("#b0e0e6"), Some((176, 224, 230)));
    assert_eq!(legacy::rgb_to_hex(176, 224, 230), "#b0e0e6");
}

#[test]
fn legacy_purple() {
    assert_eq!(legacy::named_to_hex("purple").as_deref(), Some("#800080"));
    assert_eq!(legacy::hex_to_rgb("#800080"), Some((128, 0, 128)));
    assert_eq!(legacy::rgb_to_hex(128, 0, 128), "#800080");
}

#[test]
fn legacy_rebeccapurple() {
    assert_eq!(legacy::named_to_hex("rebeccapurple").as_deref(), Some("#663399"));
    assert_eq!(legacy::hex_to_rgb("#663399"), Some((102, 51, 153)));
    assert_eq!(legacy::rgb_to_hex(102, 51, 153), "#663399");
}

#[test]
fn legacy_red() {
    assert_eq!(legacy::named_to_hex("red").as_deref(), Some("#ff0000"));
    assert_eq!(legacy::hex_to_rgb("#ff0000"), Some((255, 0, 0)));
    assert_eq!(legacy::rgb_to_hex(255, 0, 0), "#ff0000");
}

#[test]
fn legacy_rosybrown() {
    assert_eq!(legacy::named_to_hex("rosybrown").as_deref(), Some("#bc8f8f"));
    assert_eq!(legacy::hex_to_rgb("#bc8f8f"), Some((188, 143, 143)));
    assert_eq!(legacy::rgb_to_hex(188, 143, 143), "#bc8f8f");
}

#[test]
fn legacy_royalblue() {
    assert_eq!(legacy::named_to_hex("royalblue").as_deref(), Some("#4169e1"));
    assert_eq!(legacy::hex_to_rgb("#4169e1"), Some((65, 105, 225)));
    assert_eq!(legacy::rgb_to_hex(65, 105, 225), "#4169e1");
}

#[test]
fn legacy_saddlebrown() {
    assert_eq!(legacy::named_to_hex("saddlebrown").as_deref(), Some("#8b4513"));
    assert_eq!(legacy::hex_to_rgb("#8b4513"), Some((139, 69, 19)));
    assert_eq!(legacy::rgb_to_hex(139, 69, 19), "#8b4513");
}

#[test]
fn legacy_salmon() {
    assert_eq!(legacy::named_to_hex("salmon").as_deref(), Some("#fa8072"));
    assert_eq!(legacy::hex_to_rgb("#fa8072"), Some((250, 128, 114)));
    assert_eq!(legacy::rgb_to_hex(250, 128, 114), "#fa8072");
}

#[test]
fn legacy_sandybrown() {
    assert_eq!(legacy::named_to_hex("sandybrown").as_deref(), Some("#f4a460"));
    assert_eq!(legacy::hex_to_rgb("#f4a460"), Some((244, 164, 96)));
    assert_eq!(legacy::rgb_to_hex(244, 164, 96), "#f4a460");
}

#[test]
fn legacy_seagreen() {
    assert_eq!(legacy::named_to_hex("seagreen").as_deref(), Some("#2e8b57"));
    assert_eq!(legacy::hex_to_rgb("#2e8b57"), Some((46, 139, 87)));
    assert_eq!(legacy::rgb_to_hex(46, 139, 87), "#2e8b57");
}

#[test]
fn legacy_seashell() {
    assert_eq!(legacy::named_to_hex("seashell").as_deref(), Some("#fff5ee"));
    assert_eq!(legacy::hex_to_rgb("#fff5ee"), Some((255, 245, 238)));
    assert_eq!(legacy::rgb_to_hex(255, 245, 238), "#fff5ee");
}

#[test]
fn legacy_sienna() {
    assert_eq!(legacy::named_to_hex("sienna").as_deref(), Some("#a0522d"));
    assert_eq!(legacy::hex_to_rgb("#a0522d"), Some((160, 82, 45)));
    assert_eq!(legacy::rgb_to_hex(160, 82, 45), "#a0522d");
}

#[test]
fn legacy_silver() {
    assert_eq!(legacy::named_to_hex("silver").as_deref(), Some("#c0c0c0"));
    assert_eq!(legacy::hex_to_rgb("#c0c0c0"), Some((192, 192, 192)));
    assert_eq!(legacy::rgb_to_hex(192, 192, 192), "#c0c0c0");
}

#[test]
fn legacy_skyblue() {
    assert_eq!(legacy::named_to_hex("skyblue").as_deref(), Some("#87ceeb"));
    assert_eq!(legacy::hex_to_rgb("#87ceeb"), Some((135, 206, 235)));
    assert_eq!(legacy::rgb_to_hex(135, 206, 235), "#87ceeb");
}

#[test]
fn legacy_slateblue() {
    assert_eq!(legacy::named_to_hex("slateblue").as_deref(), Some("#6a5acd"));
    assert_eq!(legacy::hex_to_rgb("#6a5acd"), Some((106, 90, 205)));
    assert_eq!(legacy::rgb_to_hex(106, 90, 205), "#6a5acd");
}

#[test]
fn legacy_slategray() {
    assert_eq!(legacy::named_to_hex("slategray").as_deref(), Some("#708090"));
    assert_eq!(legacy::hex_to_rgb("#708090"), Some((112, 128, 144)));
    assert_eq!(legacy::rgb_to_hex(112, 128, 144), "#708090");
}

#[test]
fn legacy_slategrey() {
    assert_eq!(legacy::named_to_hex("slategrey").as_deref(), Some("#708090"));
    assert_eq!(legacy::hex_to_rgb("#708090"), Some((112, 128, 144)));
    assert_eq!(legacy::rgb_to_hex(112, 128, 144), "#708090");
}

#[test]
fn legacy_snow() {
    assert_eq!(legacy::named_to_hex("snow").as_deref(), Some("#fffafa"));
    assert_eq!(legacy::hex_to_rgb("#fffafa"), Some((255, 250, 250)));
    assert_eq!(legacy::rgb_to_hex(255, 250, 250), "#fffafa");
}

#[test]
fn legacy_springgreen() {
    assert_eq!(legacy::named_to_hex("springgreen").as_deref(), Some("#00ff7f"));
    assert_eq!(legacy::hex_to_rgb("#00ff7f"), Some((0, 255, 127)));
    assert_eq!(legacy::rgb_to_hex(0, 255, 127), "#00ff7f");
}

#[test]
fn legacy_steelblue() {
    assert_eq!(legacy::named_to_hex("steelblue").as_deref(), Some("#4682b4"));
    assert_eq!(legacy::hex_to_rgb("#4682b4"), Some((70, 130, 180)));
    assert_eq!(legacy::rgb_to_hex(70, 130, 180), "#4682b4");
}

#[test]
fn legacy_tan() {
    assert_eq!(legacy::named_to_hex("tan").as_deref(), Some("#d2b48c"));
    assert_eq!(legacy::hex_to_rgb("#d2b48c"), Some((210, 180, 140)));
    assert_eq!(legacy::rgb_to_hex(210, 180, 140), "#d2b48c");
}

#[test]
fn legacy_teal() {
    assert_eq!(legacy::named_to_hex("teal").as_deref(), Some("#008080"));
    assert_eq!(legacy::hex_to_rgb("#008080"), Some((0, 128, 128)));
    assert_eq!(legacy::rgb_to_hex(0, 128, 128), "#008080");
}

#[test]
fn legacy_thistle() {
    assert_eq!(legacy::named_to_hex("thistle").as_deref(), Some("#d8bfd8"));
    assert_eq!(legacy::hex_to_rgb("#d8bfd8"), Some((216, 191, 216)));
    assert_eq!(legacy::rgb_to_hex(216, 191, 216), "#d8bfd8");
}

#[test]
fn legacy_tomato() {
    assert_eq!(legacy::named_to_hex("tomato").as_deref(), Some("#ff6347"));
    assert_eq!(legacy::hex_to_rgb("#ff6347"), Some((255, 99, 71)));
    assert_eq!(legacy::rgb_to_hex(255, 99, 71), "#ff6347");
}

#[test]
fn legacy_turquoise() {
    assert_eq!(legacy::named_to_hex("turquoise").as_deref(), Some("#40e0d0"));
    assert_eq!(legacy::hex_to_rgb("#40e0d0"), Some((64, 224, 208)));
    assert_eq!(legacy::rgb_to_hex(64, 224, 208), "#40e0d0");
}

#[test]
fn legacy_violet() {
    assert_eq!(legacy::named_to_hex("violet").as_deref(), Some("#ee82ee"));
    assert_eq!(legacy::hex_to_rgb("#ee82ee"), Some((238, 130, 238)));
    assert_eq!(legacy::rgb_to_hex(238, 130, 238), "#ee82ee");
}

#[test]
fn legacy_wheat() {
    assert_eq!(legacy::named_to_hex("wheat").as_deref(), Some("#f5deb3"));
    assert_eq!(legacy::hex_to_rgb("#f5deb3"), Some((245, 222, 179)));
    assert_eq!(legacy::rgb_to_hex(245, 222, 179), "#f5deb3");
}

#[test]
fn legacy_white() {
    assert_eq!(legacy::named_to_hex("white").as_deref(), Some("#ffffff"));
    assert_eq!(legacy::hex_to_rgb("#ffffff"), Some((255, 255, 255)));
    assert_eq!(legacy::rgb_to_hex(255, 255, 255), "#ffffff");
}

#[test]
fn legacy_whitesmoke() {
    assert_eq!(legacy::named_to_hex("whitesmoke").as_deref(), Some("#f5f5f5"));
    assert_eq!(legacy::hex_to_rgb("#f5f5f5"), Some((245, 245, 245)));
    assert_eq!(legacy::rgb_to_hex(245, 245, 245), "#f5f5f5");
}

#[test]
fn legacy_yellow() {
    assert_eq!(legacy::named_to_hex("yellow").as_deref(), Some("#ffff00"));
    assert_eq!(legacy::hex_to_rgb("#ffff00"), Some((255, 255, 0)));
    assert_eq!(legacy::rgb_to_hex(255, 255, 0), "#ffff00");
}

#[test]
fn legacy_yellowgreen() {
    assert_eq!(legacy::named_to_hex("yellowgreen").as_deref(), Some("#9acd32"));
    assert_eq!(legacy::hex_to_rgb("#9acd32"), Some((154, 205, 50)));
    assert_eq!(legacy::rgb_to_hex(154, 205, 50), "#9acd32");
}
