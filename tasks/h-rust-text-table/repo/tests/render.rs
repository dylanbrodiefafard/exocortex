use texttable::{Align, Table, TableError};

#[test]
fn simple_table() {
    let mut t = Table::new(&["Name", "City"]);
    t.add_row(&["Ada", "London"]).unwrap();
    t.add_row(&["Grace", "Arlington"]).unwrap();
    assert_eq!(
        t.render(),
        "\
+-------+-----------+
| Name  |   City    |
+=======+===========+
| Ada   | London    |
| Grace | Arlington |
+-------+-----------+
"
    );
}

#[test]
fn right_aligned_column() {
    let mut t = Table::new(&["Item", "Note"]);
    t.align(1, Align::Right);
    t.add_row(&["apple", "fresh"]).unwrap();
    t.add_row(&["kiwi", "ok"]).unwrap();
    assert_eq!(
        t.render(),
        "\
+-------+-------+
| Item  | Note  |
+=======+=======+
| apple | fresh |
| kiwi  |    ok |
+-------+-------+
"
    );
}

#[test]
fn too_many_cells() {
    let mut t = Table::new(&["a", "b"]);
    t.add_row(&["1", "2"]).unwrap();
    assert_eq!(
        t.add_row(&["1", "2", "3"]),
        Err(TableError::TooManyCells { row: 1, expected: 2, got: 3 })
    );
}
