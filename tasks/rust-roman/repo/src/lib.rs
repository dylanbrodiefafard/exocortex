//! Conversion between integers and Roman numerals.

/// Converts `n` to a canonical Roman numeral (e.g. 1994 -> "MCMXCIV").
/// Returns `None` unless `1 <= n <= 3999`.
pub fn to_roman(n: u32) -> Option<String> {
    let _ = n;
    todo!()
}

/// Parses a canonical, upper-case Roman numeral (as produced by [`to_roman`]).
/// Returns `None` for anything else, including non-canonical forms such as "IIII" or "IM".
pub fn from_roman(s: &str) -> Option<u32> {
    let _ = s;
    todo!()
}
