//! Parsing CSS color strings.

use std::fmt;

use crate::color::{clamp_alpha, unit_to_byte, Hsla, Rgba};
use crate::named;

/// Why a string is not a valid color.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub input: String,
    pub reason: &'static str,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid color {:?}: {}", self.input, self.reason)
    }
}

impl std::error::Error for ParseError {}

fn err(input: &str, reason: &'static str) -> ParseError {
    ParseError { input: input.to_string(), reason }
}

/// Parses a CSS color: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()`,
/// `hsl()`/`hsla()`, a named color or `transparent`. Case-insensitive; surrounding
/// whitespace is ignored.
pub fn parse(input: &str) -> Result<Rgba, ParseError> {
    let s = input.trim().to_ascii_lowercase();
    if s.is_empty() {
        return Err(err(input, "empty"));
    }
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex(input, hex);
    }
    if let Some((name, args)) = split_function(&s) {
        let args: Vec<&str> = args.split(',').map(str::trim).collect();
        return match name {
            "rgb" | "rgba" => parse_rgb(input, &args),
            "hsl" | "hsla" => parse_hsl(input, &args),
            _ => Err(err(input, "unknown function")),
        };
    }
    if s == "transparent" {
        return Ok(Rgba::rgba(0, 0, 0, 0.0));
    }
    match named::lookup(&s) {
        Some(c) => Ok(c),
        None => Err(err(input, "unknown color name")),
    }
}

fn split_function(s: &str) -> Option<(&str, &str)> {
    let open = s.find('(')?;
    let inner = s[open + 1..].strip_suffix(')')?;
    Some((s[..open].trim_end(), inner))
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

fn parse_hex(input: &str, hex: &str) -> Result<Rgba, ParseError> {
    let digits: Option<Vec<u8>> = hex.bytes().map(hex_digit).collect();
    let d = digits.ok_or_else(|| err(input, "bad hex digit"))?;
    let bytes: Vec<u8> = match d.len() {
        3 | 4 => d.iter().map(|n| n * 17).collect(),
        6 | 8 => d.chunks(2).map(|p| p[0] * 16 + p[1]).collect(),
        _ => return Err(err(input, "hex color must have 3, 4, 6 or 8 digits")),
    };
    let a = if bytes.len() == 4 { f64::from(bytes[3]) / 255.0 } else { 1.0 };
    Ok(Rgba::rgba(bytes[0], bytes[1], bytes[2], a))
}

fn parse_number(s: &str) -> Option<f64> {
    if s.is_empty() || s.contains(char::is_whitespace) {
        return None;
    }
    let v: f64 = s.parse().ok()?;
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

fn parse_percent(s: &str) -> Option<f64> {
    parse_number(s.strip_suffix('%')?)
}

fn parse_alpha(input: &str, s: &str) -> Result<f64, ParseError> {
    let a = if s.ends_with('%') {
        parse_percent(s).map(|p| p / 100.0)
    } else {
        parse_number(s)
    };
    a.map(clamp_alpha).ok_or_else(|| err(input, "bad alpha"))
}

fn parse_rgb(input: &str, args: &[&str]) -> Result<Rgba, ParseError> {
    if args.len() != 3 && args.len() != 4 {
        return Err(err(input, "rgb() takes 3 or 4 arguments"));
    }
    let percent = args[0].ends_with('%');
    let mut ch = [0u8; 3];
    for (i, arg) in args[..3].iter().enumerate() {
        if arg.ends_with('%') != percent {
            return Err(err(input, "rgb() channels must be all numbers or all percentages"));
        }
        let unit = if percent {
            parse_percent(arg).map(|p| p / 100.0)
        } else {
            parse_number(arg).map(|v| v / 255.0)
        };
        ch[i] = unit_to_byte(unit.ok_or_else(|| err(input, "bad rgb() channel"))?);
    }
    let a = if args.len() == 4 { parse_alpha(input, args[3])? } else { 1.0 };
    Ok(Rgba::rgba(ch[0], ch[1], ch[2], a))
}

fn parse_hsl(input: &str, args: &[&str]) -> Result<Rgba, ParseError> {
    if args.len() != 3 && args.len() != 4 {
        return Err(err(input, "hsl() takes 3 or 4 arguments"));
    }
    let hue = args[0].strip_suffix("deg").unwrap_or(args[0]);
    let h = parse_number(hue).ok_or_else(|| err(input, "bad hue"))?;
    let s = parse_percent(args[1]).ok_or_else(|| err(input, "saturation must be a percentage"))?;
    let l = parse_percent(args[2]).ok_or_else(|| err(input, "lightness must be a percentage"))?;
    let a = if args.len() == 4 { parse_alpha(input, args[3])? } else { 1.0 };
    Ok(Hsla::new(h, s, l, a).to_rgba())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_hex() {
        assert_eq!(parse("#f80").unwrap(), Rgba::rgb(255, 136, 0));
    }

    #[test]
    fn long_hex_upper() {
        assert_eq!(parse("  #FF8800 ").unwrap(), Rgba::rgb(255, 136, 0));
    }

    #[test]
    fn hex_errors() {
        for s in ["#", "#12", "#12345", "#1234567", "#ggg", "#123456789"] {
            assert!(parse(s).is_err(), "{s} should not parse");
        }
    }

    #[test]
    fn rgb_numbers() {
        assert_eq!(parse("rgb(1, 2, 3)").unwrap(), Rgba::rgb(1, 2, 3));
        assert_eq!(parse("RGB( 300 ,-5, 12.6 )").unwrap(), Rgba::rgb(255, 0, 13));
    }

    #[test]
    fn rgb_mixed_units_rejected() {
        assert!(parse("rgb(10%, 20, 30)").is_err());
    }

    #[test]
    fn transparent() {
        assert_eq!(parse("transparent").unwrap(), Rgba::rgba(0, 0, 0, 0.0));
    }

    #[test]
    fn unknown() {
        assert_eq!(parse("blurple").unwrap_err().reason, "unknown color name");
        assert!(parse("cmyk(0, 0, 0, 0)").is_err());
        assert!(parse("").is_err());
    }
}
