mod common;

use common::{assert_fmt, fmt, run, ty};

#[test]
fn integer_power() {
    assert_eq!(run("2 ** 10"), "1024");
    assert_eq!(run("2**3"), "8");
    assert_eq!(run("(-3) ** 3"), "-27");
    assert_eq!(run("7 ** 0"), "1");
    assert_eq!(run("0 ** 0"), "1");
    assert_eq!(run("(-1) ** 9223372036854775807"), "-1");
    assert_eq!(run("let n = 5 in n ** 2 - n"), "20");
}

#[test]
fn float_power() {
    assert_eq!(run("4 ** 0.5"), "2.0");
    assert_eq!(run("2.0 ** 3"), "8.0");
    assert_eq!(run("2.5 ** 2"), "6.25");
    assert_eq!(run("2.0 ** -1"), "0.5");
    assert_eq!(run("2 ** -1.0"), "0.5");
}

#[test]
fn same_as_pow() {
    for (a, b) in [("3", "4"), ("2", "0.5"), ("10.0", "-2"), ("-2", "5"), ("1.5", "2.0")] {
        assert_eq!(run(&format!("{a} ** {b}")), run(&format!("pow({a}, {b})")), "{a} ** {b}");
    }
}

#[test]
fn runtime_errors_point_at_the_operator() {
    assert_eq!(run("2 ** 63"), "runtime error at 1:3: integer overflow");
    assert_eq!(run("let x = 10 in x ** 19"), "runtime error at 1:17: integer overflow");
    assert_eq!(run("2 ** -1"), "runtime error at 1:3: negative exponent in integer power");
    assert_eq!(run("(-8.0) ** 0.5"), "runtime error at 1:8: result is not a finite number");
    assert_eq!(run("1 +\n 10.0 ** 400"), "runtime error at 2:7: result is not a finite number");
}

#[test]
fn types() {
    assert_eq!(ty("2 ** 3"), "Int");
    assert_eq!(ty("2 ** 0.5"), "Float");
    assert_eq!(ty("[1.5][0] ** 2"), "Float");
    assert_eq!(ty("\"a\" ** 2"), "type error at 1:5: operator `**` expects numbers, found Str and Int");
    assert_eq!(ty("2 ** true"), "type error at 1:3: operator `**` expects numbers, found Int and Bool");
    assert_eq!(ty("not 2 ** 2 == 4"), "type error at 1:1: operator `not` expects Bool, found Int");
}

#[test]
fn precedence_and_associativity() {
    assert_eq!(run("-2 ** 2"), "-4");
    assert_eq!(run("(-2) ** 2"), "4");
    assert_eq!(run("2 ** 3 ** 2"), "512");
    assert_eq!(run("(2 ** 3) ** 2"), "64");
    assert_eq!(run("2 * 3 ** 2"), "18");
    assert_eq!(run("10 - 2 ** 3 * 2"), "-6");
    assert_eq!(run("[2, 3][1] ** 2"), "9");
    assert_eq!(run("2 ** [2, 3][1]"), "8");
    assert_eq!(run("2 ** max(1, 3)"), "8");
    assert_eq!(run("2.0 ** -1 ** 2"), "0.5");
    assert_eq!(run("2 ** 2 == 4 and 3 ** 2 > 8"), "true");
}

#[test]
fn not_confused_with_star() {
    assert_eq!(run("2 * 3"), "6");
    assert_eq!(fmt("2 * * 3"), "syntax error at 1:5: expected an expression, found `*`");
    assert_eq!(fmt("2 *** 3"), "syntax error at 1:5: expected an expression, found `*`");
    assert_eq!(fmt("** 3"), "syntax error at 1:1: expected an expression, found `**`");
}

#[test]
fn formatting() {
    assert_fmt("2**3", "2 ** 3");
    assert_fmt("2 ** 3 ** 2", "2 ** 3 ** 2");
    assert_fmt("2 ** (3 ** 2)", "2 ** 3 ** 2");
    assert_fmt("(2 ** 3) ** 2", "(2 ** 3) ** 2");
    assert_fmt("-2 ** 2", "-2 ** 2");
    assert_fmt("-(2 ** 2)", "-2 ** 2");
    assert_fmt("(-2) ** 2", "(-2) ** 2");
    assert_fmt("2 ** -1", "2 ** -1");
    assert_fmt("2 ** (-1)", "2 ** -1");
    assert_fmt("2 ** -(1 + 1)", "2 ** -(1 + 1)");
    assert_fmt("2 ** -1 ** 2", "2 ** -1 ** 2");
    assert_fmt("2 ** (-1) ** 2", "2 ** (-1) ** 2");
    assert_fmt("(2 ** -1) ** 2", "(2 ** -1) ** 2");
    assert_fmt("2 * 3 ** 2", "2 * 3 ** 2");
    assert_fmt("(2 * 3) ** 2", "(2 * 3) ** 2");
    assert_fmt("2 ** (3 * 2)", "2 ** (3 * 2)");
    assert_fmt("xs[0] ** 2", "xs[0] ** 2");
    assert_fmt("(xs ** 2)[0]", "(xs ** 2)[0]");
    assert_fmt("(if c then 2 else 3) ** 2", "(if c then 2 else 3) ** 2");
    assert_fmt("2 ** (if c then 2 else 3)", "2 ** (if c then 2 else 3)");
    assert_fmt("not (a ** 2)", "not a ** 2");
    assert_fmt("(not a) ** 2", "(not a) ** 2");
    assert_fmt("a ** not b", "a ** not b");
    assert_fmt("x - -y * z", "x - -y * z");
}

#[test]
fn listed_by_rill_ops() {
    let text = rill::describe_operators();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "**    80  right  exponentiation");
    assert_eq!(lines[1], "-     70  prefix negation");
}

#[test]
fn documented() {
    let doc = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/docs/language.md")).unwrap();
    assert!(doc.contains("`**`"), "docs/language.md does not mention `**`");
}
