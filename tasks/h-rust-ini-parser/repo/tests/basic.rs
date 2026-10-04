use ini::parse;

#[test]
fn sections_and_keys() {
    let ini = parse("[server]\nhost = example.org\nport = 8080\n\n[client]\nretries = 3\n").unwrap();
    assert_eq!(ini.sections(), vec!["server", "client"]);
    assert_eq!(ini.get("server", "host"), Some("example.org"));
    assert_eq!(ini.get("server", "port"), Some("8080"));
    assert_eq!(ini.get("client", "retries"), Some("3"));
    assert_eq!(ini.get("client", "host"), None);
    assert_eq!(ini.get("missing", "host"), None);
}

#[test]
fn values_and_keys_are_trimmed() {
    let ini = parse("[a]\n   key   =    some value   \n").unwrap();
    assert_eq!(ini.get("a", "key"), Some("some value"));
}

#[test]
fn full_line_comments_and_blank_lines() {
    let ini = parse("; comment\n# another\n\n[a]\n  ; indented comment\nx=1\n\n").unwrap();
    assert_eq!(ini.sections(), vec!["a"]);
    assert_eq!(ini.get("a", "x"), Some("1"));
}

#[test]
fn empty_input() {
    let ini = parse("").unwrap();
    assert!(ini.sections().is_empty());
}
