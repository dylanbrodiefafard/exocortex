use texttable::{Align, Table, TableError};

fn table(headers: &[&str], rows: &[&[&str]]) -> Table {
    let mut t = Table::new(headers);
    for r in rows {
        t.add_row(r).unwrap();
    }
    t
}

// --- widths ---------------------------------------------------------------

#[test]
fn width_counts_chars_not_bytes() {
    let t = table(&["Ort", "Note"], &[&["Zürich", "café ✓"], &["Bern", "ok"]]);
    assert_eq!(
        t.render(),
        "\
+--------+--------+
|  Ort   |  Note  |
+========+========+
| Zürich | café ✓ |
| Bern   | ok     |
+--------+--------+
"
    );
}

#[test]
fn minimum_width_is_one() {
    let t = table(&["", "x"], &[&["", "y"]]);
    assert_eq!(
        t.render(),
        "\
+---+---+
|   | x |
+===+===+
|   | y |
+---+---+
"
    );
}

// --- alignment ------------------------------------------------------------

#[test]
fn headers_are_always_centered() {
    let mut t = table(&["ab", "cd", "ef"], &[&["xxxxx", "yyyyyy", "zzzzzzz"]]);
    t.align(0, Align::Left).align(1, Align::Right).align(2, Align::Center);
    assert_eq!(
        t.render(),
        "\
+-------+--------+---------+
|  ab   |   cd   |   ef    |
+=======+========+=========+
| xxxxx | yyyyyy | zzzzzzz |
+-------+--------+---------+
"
    );
}

#[test]
fn center_puts_extra_space_on_the_right() {
    let mut t = table(&["Title"], &[&["a"], &["ab"], &["abc"], &["abcd"]]);
    t.align(0, Align::Center);
    assert_eq!(
        t.render(),
        "\
+-------+
| Title |
+=======+
|   a   |
|  ab   |
|  abc  |
| abcd  |
+-------+
"
    );
}

#[test]
fn numeric_columns_default_to_right() {
    let t = table(
        &["Item", "Qty", "Price", "Code"],
        &[&["apple", "3", "1.25", "A1"], &["melon", "12", "-0.50", "7"], &["kiwi", "", "10", "9"]],
    );
    assert_eq!(
        t.render(),
        "\
+-------+-----+-------+------+
| Item  | Qty | Price | Code |
+=======+=====+=======+======+
| apple |   3 |  1.25 | A1   |
| melon |  12 | -0.50 | 7    |
| kiwi  |     |    10 | 9    |
+-------+-----+-------+------+
"
    );
}

#[test]
fn number_format_is_strict() {
    for bad in ["+1", "1.", ".5", "1e3", "1,000", "--1", "1.2.3", "-", "0x10", "١٢"] {
        let t = table(&["column"], &[&["10"], &[bad]]);
        let out = t.render();
        let line = out.lines().find(|l| l.contains("10")).unwrap();
        assert!(line.starts_with("| 10"), "{bad:?} should make the column left-aligned:\n{out}");
    }
    for good in ["0", "-7", "123.456", "-0.0", "007"] {
        let t = table(&["number"], &[&["1"], &[good]]);
        let out = t.render();
        let line = out.lines().find(|l| l.contains(" 1 ")).unwrap();
        assert!(line.ends_with(" 1 |"), "{good:?} should keep the column right-aligned:\n{out}");
    }
}

#[test]
fn numeric_detection_ignores_trailing_whitespace_and_blank_cells() {
    let t = table(&["count"], &[&["5  "], &["   "], &["17\t"]]);
    assert_eq!(
        t.render(),
        "\
+-------+
| count |
+=======+
|     5 |
|       |
|    17 |
+-------+
"
    );
}

#[test]
fn empty_cells_do_not_affect_numeric_detection() {
    let t = table(&["aaa", "bbbb"], &[&["1"], &["", ""], &["22", ""]]);
    assert_eq!(
        t.render(),
        "\
+-----+------+
| aaa | bbbb |
+=====+======+
|   1 |      |
|     |      |
|  22 |      |
+-----+------+
"
    );
}

#[test]
fn explicit_alignment_wins_over_numeric() {
    let mut t = table(&["Qty", "Name"], &[&["3"], &["12", "x"]]);
    t.align(0, Align::Left).align(1, Align::Right);
    assert_eq!(
        t.render(),
        "\
+-----+------+
| Qty | Name |
+=====+======+
| 3   |      |
| 12  |    x |
+-----+------+
"
    );
}

// --- multi-line, whitespace -------------------------------------------------

#[test]
fn multi_line_cells() {
    let mut t = table(&["Key", "Value"], &[&["a", "one\ntwo\nthree"], &["b\nc", "x"]]);
    t.align(1, Align::Right);
    assert_eq!(
        t.render(),
        "\
+-----+-------+
| Key | Value |
+=====+=======+
| a   |   one |
|     |   two |
|     | three |
| b   |     x |
| c   |       |
+-----+-------+
"
    );
}

#[test]
fn multi_line_headers() {
    let t = table(&["Unit\nPrice", "Name"], &[&["4", "tea"]]);
    assert_eq!(
        t.render(),
        "\
+-------+------+
| Unit  | Name |
| Price |      |
+=======+======+
|     4 | tea  |
+-------+------+
"
    );
}

#[test]
fn trailing_whitespace_trimmed_leading_kept_tabs_replaced() {
    let t = table(&["x"], &[&["  ab  \t"], &["a\tb\r"], &["\tc"], &["d \r\n  e\t "]]);
    assert_eq!(
        t.render(),
        "\
+------+
|  x   |
+======+
|   ab |
| a b  |
|  c   |
| d    |
|   e  |
+------+
"
    );
}

#[test]
fn header_whitespace_trimmed_too() {
    let t = table(&["name   "], &[&["bob"]]);
    assert_eq!(
        t.render(),
        "\
+------+
| name |
+======+
| bob  |
+------+
"
    );
}

// --- max width --------------------------------------------------------------

#[test]
fn max_width_truncates_with_ellipsis() {
    let mut t = table(&["Description", "N"], &[&["A rather long line", "1"], &["short", "2"]]);
    t.max_width(0, 8);
    assert_eq!(
        t.render(),
        "\
+----------+---+
| Descrip… | N |
+==========+===+
| A rathe… | 1 |
| short    | 2 |
+----------+---+
"
    );
}

#[test]
fn max_width_is_a_cap_not_a_width() {
    let mut t = table(&["ab"], &[&["cde"]]);
    t.max_width(0, 10);
    assert_eq!(t.render(), "+-----+\n| ab  |\n+=====+\n| cde |\n+-----+\n");
}

#[test]
fn max_width_exact_fit_is_not_truncated() {
    let mut t = table(&["h"], &[&["abcd"], &["abcde"]]);
    t.max_width(0, 4);
    assert_eq!(t.render(), "+------+\n|  h   |\n+======+\n| abcd |\n| abc… |\n+------+\n");
}

#[test]
fn max_width_one() {
    let mut t = table(&["hdr"], &[&["x"], &["yy"]]);
    t.max_width(0, 1);
    assert_eq!(t.render(), "+---+\n| … |\n+===+\n| x |\n| … |\n+---+\n");
}

#[test]
fn max_width_counts_chars_and_applies_per_line() {
    let mut t = table(&["n"], &[&["ééééé\nok\n日本語テキスト"]]);
    t.max_width(0, 4);
    assert_eq!(
        t.render(),
        "\
+------+
|  n   |
+======+
| ééé… |
| ok   |
| 日本語… |
+------+
"
    );
}

#[test]
fn truncation_happens_after_trimming() {
    let mut t = table(&["n"], &[&["abc      "], &["a\tbcdef"]]);
    t.max_width(0, 4);
    assert_eq!(t.render(), "+------+\n|  n   |\n+======+\n| abc  |\n| a b… |\n+------+\n");
}

#[test]
#[should_panic]
fn max_width_zero_panics() {
    Table::new(&["a"]).max_width(0, 0);
}

// --- rows -------------------------------------------------------------------

#[test]
fn short_rows_are_padded() {
    let t = table(&["a", "b", "c"], &[&["1"], &[], &["x", "y", "z"]]);
    assert_eq!(
        t.render(),
        "\
+---+---+---+
| a | b | c |
+===+===+===+
| 1 |   |   |
|   |   |   |
| x | y | z |
+---+---+---+
"
    );
}

#[test]
fn rejected_row_leaves_table_unchanged() {
    let mut t = Table::new(&["a", "b"]);
    assert_eq!(
        t.add_row(&["1", "2", "3"]),
        Err(TableError::TooManyCells { row: 0, expected: 2, got: 3 })
    );
    let empty = t.render();
    assert_eq!(empty, "+---+---+\n| a | b |\n+---+---+\n");
    t.add_row(&["p", "q"]).unwrap();
    assert_eq!(
        t.add_row(&["1", "2", "3", "4"]),
        Err(TableError::TooManyCells { row: 1, expected: 2, got: 4 })
    );
    t.add_row(&["r", "s"]).unwrap();
    assert_eq!(
        t.add_row(&["", "", ""]),
        Err(TableError::TooManyCells { row: 2, expected: 2, got: 3 })
    );
    assert_eq!(t.render(), "+---+---+\n| a | b |\n+===+===+\n| p | q |\n| r | s |\n+---+---+\n");
}

#[test]
fn no_body_rows() {
    let t = Table::new(&["Name", "Multi\nline"]);
    assert_eq!(
        t.render(),
        "\
+------+-------+
| Name | Multi |
|      | line  |
+------+-------+
"
    );
}

#[test]
fn separate_rows() {
    let mut t = table(&["k", "v"], &[&["a", "1"], &["b", "2\n3"], &["c", "4"]]);
    t.separate_rows(true);
    assert_eq!(
        t.render(),
        "\
+---+---+
| k | v |
+===+===+
| a | 1 |
+---+---+
| b | 2 |
|   | 3 |
+---+---+
| c | 4 |
+---+---+
"
    );
    t.separate_rows(false);
    assert_eq!(t.render(), "+---+---+\n| k | v |\n+===+===+\n| a | 1 |\n| b | 2 |\n|   | 3 |\n| c | 4 |\n+---+---+\n");
}

#[test]
fn separate_rows_with_single_row_or_none() {
    let mut t = Table::new(&["k"]);
    t.separate_rows(true);
    assert_eq!(t.render(), "+---+\n| k |\n+---+\n");
    t.add_row(&["a"]).unwrap();
    assert_eq!(t.render(), "+---+\n| k |\n+===+\n| a |\n+---+\n");
}

#[test]
fn no_columns_renders_empty() {
    let mut t = Table::new(&[]);
    assert_eq!(t.render(), "");
    t.add_row(&[]).unwrap();
    assert_eq!(t.render(), "");
    assert_eq!(t.add_row(&["x"]), Err(TableError::TooManyCells { row: 1, expected: 0, got: 1 }));
}

#[test]
#[should_panic]
fn align_out_of_range_panics() {
    Table::new(&["a", "b"]).align(2, Align::Left);
}

#[test]
#[should_panic]
fn max_width_out_of_range_panics() {
    Table::new(&["a"]).max_width(1, 5);
}

#[test]
fn render_is_repeatable_and_reflects_changes() {
    let mut t = table(&["n"], &[&["5"]]);
    let first = t.render();
    assert_eq!(first, t.render());
    assert_eq!(first, "+---+\n| n |\n+===+\n| 5 |\n+---+\n");
    t.add_row(&["word"]).unwrap();
    assert_eq!(t.render(), "+------+\n|  n   |\n+======+\n| 5    |\n| word |\n+------+\n");
    t.align(0, Align::Right);
    assert_eq!(t.render(), "+------+\n|  n   |\n+======+\n|    5 |\n| word |\n+------+\n");
    t.max_width(0, 3);
    assert_eq!(t.render(), "+-----+\n|  n  |\n+=====+\n|   5 |\n| wo… |\n+-----+\n");
}
