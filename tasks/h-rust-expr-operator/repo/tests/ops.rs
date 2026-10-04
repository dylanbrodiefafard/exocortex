use rill::syntax::ops::{self, binary_op, info, Assoc, BINARY_OPS, POSTFIX_PREC, UNARY_PREC};

#[test]
fn table_is_consistent() {
    for (i, entry) in BINARY_OPS.iter().enumerate() {
        assert!(std::ptr::eq(info(entry.op), entry), "{:?} appears twice", entry.op);
        assert!(std::ptr::eq(binary_op(&entry.token).unwrap(), entry), "token {:?} maps to two operators", entry.token);
        assert!(entry.prec > 0 && entry.prec < POSTFIX_PREC && entry.prec != UNARY_PREC, "{}: bad precedence", entry.symbol);
        assert!(!entry.description.is_empty());
        for other in &BINARY_OPS[..i] {
            if other.prec == entry.prec {
                assert_eq!(other.assoc, entry.assoc, "{} and {} share a level but not associativity", other.symbol, entry.symbol);
            }
        }
    }
}

#[test]
fn comparisons_are_not_associative() {
    for entry in BINARY_OPS.iter().filter(|e| e.prec == 30) {
        assert_eq!(entry.assoc, Assoc::None);
    }
}

#[test]
fn describe_lists_every_operator_tightest_first() {
    let text = ops::describe();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), BINARY_OPS.len() + 2);
    let neg = lines.iter().position(|l| *l == "-     70  prefix negation").expect("negation listed");
    assert_eq!(lines[neg + 1], "not   70  prefix logical not");
    assert!(lines.contains(&"++    40  right  concatenation of strings or lists"));
    assert!(lines.contains(&"<=    30  none   less than or equal"));
    assert_eq!(*lines.last().unwrap(), "or    10  left   logical or (short-circuit)");
    let precs: Vec<u8> = lines.iter().map(|l| l[5..8].trim().parse().unwrap()).collect();
    assert!(precs.windows(2).all(|w| w[0] >= w[1]), "not sorted: {precs:?}");
    assert_eq!(rill::describe_operators(), text);
}
