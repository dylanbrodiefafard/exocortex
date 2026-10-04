use roman::{from_roman, to_roman};

#[test]
fn converts_known_values() {
    let cases = [
        (1, "I"),
        (4, "IV"),
        (9, "IX"),
        (14, "XIV"),
        (40, "XL"),
        (90, "XC"),
        (400, "CD"),
        (1994, "MCMXCIV"),
        (2024, "MMXXIV"),
        (3999, "MMMCMXCIX"),
    ];
    for (n, s) in cases {
        assert_eq!(to_roman(n).as_deref(), Some(s), "to_roman({n})");
        assert_eq!(from_roman(s), Some(n), "from_roman({s})");
    }
}

#[test]
fn rejects_out_of_range() {
    assert_eq!(to_roman(0), None);
    assert_eq!(to_roman(4000), None);
}

#[test]
fn rejects_invalid_numerals() {
    for s in ["", "IIII", "IM", "VX", "MMMM", "iv", "XIVX", "ABC", "IIV"] {
        assert_eq!(from_roman(s), None, "from_roman({s:?})");
    }
}

#[test]
fn round_trips_every_value() {
    for n in 1..=3999 {
        let s = to_roman(n).expect("in range");
        assert_eq!(from_roman(&s), Some(n), "round trip {n} via {s}");
    }
}
