use ini::{parse, ErrorKind, ParseError};

fn err(input: &str) -> ParseError {
    match parse(input) {
        Ok(ini) => panic!("expected an error for {input:?}, got {ini:?}"),
        Err(e) => e,
    }
}

fn value(input: &str) -> Option<String> {
    parse(input)
        .unwrap_or_else(|e| panic!("parse({input:?}) failed: {e:?}"))
        .get("s", "k")
        .map(str::to_string)
}

fn v(line: &str) -> String {
    value(&format!("[s]\n{line}\n")).unwrap_or_else(|| panic!("no value for {line:?}"))
}

// --- sections -------------------------------------------------------------

#[test]
fn section_names_are_lowercased() {
    let ini = parse("[Server]\nHost = a\n").unwrap();
    assert_eq!(ini.sections(), vec!["server"]);
    assert_eq!(ini.get("server", "Host"), Some("a"));
}

#[test]
fn get_matches_section_case_insensitively() {
    let ini = parse("[Server]\nhost = a\n").unwrap();
    assert_eq!(ini.get("SERVER", "host"), Some("a"));
    assert_eq!(ini.get("sErVeR", "host"), Some("a"));
}

#[test]
fn keys_are_case_sensitive() {
    let ini = parse("[s]\nKey = upper\nkey = lower\n").unwrap();
    assert_eq!(ini.get("s", "Key"), Some("upper"));
    assert_eq!(ini.get("s", "key"), Some("lower"));
    assert_eq!(ini.get("s", "KEY"), None);
}

#[test]
fn section_name_is_trimmed() {
    let ini = parse("  [  My Section  ]  \nk = v\n").unwrap();
    assert_eq!(ini.sections(), vec!["my section"]);
    assert_eq!(ini.get("my section", "k"), Some("v"));
}

#[test]
fn reopened_section_merges() {
    let ini = parse("[a]\nx = 1\n[b]\ny = 2\n[A]\nz = 3\n").unwrap();
    assert_eq!(ini.sections(), vec!["a", "b"]);
    assert_eq!(ini.get("a", "x"), Some("1"));
    assert_eq!(ini.get("a", "z"), Some("3"));
}

#[test]
fn empty_section_is_listed() {
    let ini = parse("[empty]\n[full]\nk = v\n").unwrap();
    assert_eq!(ini.sections(), vec!["empty", "full"]);
}

#[test]
fn header_with_inline_comment() {
    let ini = parse("[a] ; the a section\nk = v\n").unwrap();
    assert_eq!(ini.sections(), vec!["a"]);
    assert_eq!(ini.get("a", "k"), Some("v"));
}

// --- global section -------------------------------------------------------

#[test]
fn keys_before_first_section_are_global() {
    let ini = parse("name = demo\n[s]\nk = v\n").unwrap();
    assert_eq!(ini.sections(), vec!["", "s"]);
    assert_eq!(ini.get("", "name"), Some("demo"));
    assert_eq!(ini.get("s", "name"), None);
}

#[test]
fn no_global_section_without_global_keys() {
    let ini = parse("; header comment\n\n[s]\nk = v\n").unwrap();
    assert_eq!(ini.sections(), vec!["s"]);
    assert_eq!(ini.get("", "k"), None);
}

#[test]
fn only_global_keys() {
    let ini = parse("a = 1\nb = 2").unwrap();
    assert_eq!(ini.sections(), vec![""]);
    assert_eq!(ini.get("", "b"), Some("2"));
}

// --- keys and values ------------------------------------------------------

#[test]
fn duplicate_key_last_wins() {
    let ini = parse("[s]\nk = first\nother = x\nk = second\n[t]\n[S]\nk = third\n").unwrap();
    assert_eq!(ini.get("s", "k"), Some("third"));
    assert_eq!(ini.get("s", "other"), Some("x"));
}

#[test]
fn value_splits_at_first_equals() {
    assert_eq!(v("k = a=b=c"), "a=b=c");
    assert_eq!(v("k==x"), "=x");
}

#[test]
fn empty_value() {
    assert_eq!(v("k ="), "");
    assert_eq!(v("k =    "), "");
}

#[test]
fn tabs_are_whitespace() {
    assert_eq!(v("\tk\t=\tvalue\t"), "value");
}

#[test]
fn crlf_line_endings() {
    let ini = parse("[s]\r\nk = v\r\nj = \"q\"\r\n").unwrap();
    assert_eq!(ini.get("s", "k"), Some("v"));
    assert_eq!(ini.get("s", "j"), Some("q"));
}

#[test]
fn hash_and_semicolon_comment_lines_inside_sections() {
    let ini = parse("[s]\n# k = no\n   ; k = nope\nk = yes\n").unwrap();
    assert_eq!(ini.get("s", "k"), Some("yes"));
}

// --- inline comments ------------------------------------------------------

#[test]
fn inline_comment_after_whitespace() {
    assert_eq!(v("k = value ; comment"), "value");
    assert_eq!(v("k = value\t; comment"), "value");
    assert_eq!(v("k = a b  ;c ; d"), "a b");
}

#[test]
fn semicolon_without_whitespace_is_literal() {
    assert_eq!(v("k = a;b"), "a;b");
    assert_eq!(v("k = a;b ;c"), "a;b");
}

#[test]
fn hash_is_never_inline_comment() {
    assert_eq!(v("k = color #fff"), "color #fff");
    assert_eq!(v("k = a # b ; c"), "a # b");
}

#[test]
fn value_that_is_only_a_comment() {
    assert_eq!(v("k = ; nothing here"), "");
}

// --- quoted values --------------------------------------------------------

#[test]
fn quoted_value_keeps_inner_whitespace() {
    assert_eq!(v("k = \"  padded  \""), "  padded  ");
    assert_eq!(v("k = \"\""), "");
}

#[test]
fn quoted_value_keeps_comment_characters() {
    assert_eq!(v("k = \"a ; b # c\""), "a ; b # c");
}

#[test]
fn quoted_value_escapes() {
    assert_eq!(v(r#"k = "say \"hi\"""#), "say \"hi\"");
    assert_eq!(v(r#"k = "back\\slash""#), "back\\slash");
    assert_eq!(v(r#"k = "line1\nline2""#), "line1\nline2");
    assert_eq!(v(r#"k = "a\tb""#), "a\tb");
}

#[test]
fn escaped_backslash_before_closing_quote() {
    assert_eq!(v(r#"k = "ends with \\""#), "ends with \\");
}

#[test]
fn unknown_escape_is_kept_literally() {
    assert_eq!(v(r#"k = "C:\path\x""#), r"C:\path\x");
}

#[test]
fn quoted_value_followed_by_comment() {
    assert_eq!(v("k = \"v\"   ; note"), "v");
    assert_eq!(v("k = \"v\";note"), "v");
    assert_eq!(v("k = \"v\"   "), "v");
}

#[test]
fn quote_not_at_start_is_literal() {
    assert_eq!(v("k = say \"hi\""), "say \"hi\"");
}

// --- errors ---------------------------------------------------------------

#[test]
fn missing_equals() {
    assert_eq!(
        err("[s]\nk = v\njust words\n"),
        ParseError { line: 3, kind: ErrorKind::MissingEquals }
    );
}

#[test]
fn empty_key() {
    assert_eq!(err("[s]\n = v\n"), ParseError { line: 2, kind: ErrorKind::EmptyKey });
    assert_eq!(err("=v"), ParseError { line: 1, kind: ErrorKind::EmptyKey });
}

#[test]
fn unterminated_quote() {
    assert_eq!(
        err("[s]\nk = \"open\n"),
        ParseError { line: 2, kind: ErrorKind::UnterminatedQuote }
    );
    assert_eq!(
        err("[s]\nk = \"escaped end\\\"\n"),
        ParseError { line: 2, kind: ErrorKind::UnterminatedQuote }
    );
}

#[test]
fn trailing_characters_after_quote() {
    assert_eq!(
        err("[s]\nk = \"a\" b\n"),
        ParseError { line: 2, kind: ErrorKind::TrailingCharacters }
    );
}

#[test]
fn invalid_section_headers() {
    for bad in ["[unclosed", "[]", "[   ]", "[a]b", "[a[b]", "[a]]", "[a];c"] {
        assert_eq!(
            err(&format!("x = 1\n\n{bad}\n")),
            ParseError { line: 3, kind: ErrorKind::InvalidSectionHeader },
            "header {bad:?}"
        );
    }
}

#[test]
fn line_numbers_count_comments_blanks_and_crlf() {
    let input = "; c\r\n\r\n[s]\r\n# c\r\nk = v\r\n\r\noops\r\n";
    assert_eq!(err(input), ParseError { line: 7, kind: ErrorKind::MissingEquals });
}

#[test]
fn first_error_wins() {
    let input = "[s]\nk = v\n[bad\n = x\n";
    assert_eq!(err(input), ParseError { line: 3, kind: ErrorKind::InvalidSectionHeader });
}

#[test]
fn error_display_mentions_line() {
    let e = err("[s]\n\nnope\n");
    assert!(e.to_string().contains('3'), "{e}");
}
