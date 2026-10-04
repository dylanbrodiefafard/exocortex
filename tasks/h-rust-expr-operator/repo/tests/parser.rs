mod common;

use common::{assert_fmt, fmt};

#[test]
fn precedence() {
    assert_fmt("1 + 2 * 3", "1 + 2 * 3");
    assert_fmt("(1 + 2) * 3", "(1 + 2) * 3");
    assert_fmt("a or b and c", "a or b and c");
    assert_fmt("(a or b) and c", "(a or b) and c");
    assert_fmt("1 + 2 < 3 * 4", "1 + 2 < 3 * 4");
    assert_fmt("a ++ b == c", "a ++ b == c");
}

#[test]
fn associativity() {
    assert_fmt("1 - 2 - 3", "1 - 2 - 3");
    assert_fmt("1 - (2 - 3)", "1 - (2 - 3)");
    assert_fmt("a ++ b ++ c", "a ++ b ++ c");
    assert_fmt("(a ++ b) ++ c", "(a ++ b) ++ c");
    assert_fmt("a ++ (b ++ c)", "a ++ b ++ c");
}

#[test]
fn prefix_operators() {
    assert_fmt("-x * y", "-x * y");
    assert_fmt("-(x * y)", "-(x * y)");
    assert_fmt("- - x", "--x");
    assert_fmt("not a and b", "not a and b");
    assert_fmt("not (a and b)", "not (a and b)");
    assert_fmt("x - -y", "x - -y");
    assert_fmt("-xs[0]", "-xs[0]");
    assert_fmt("(-xs)[0]", "(-xs)[0]");
}

#[test]
fn if_and_let() {
    assert_fmt("if a then 1 else 2 + 3", "if a then 1 else 2 + 3");
    assert_fmt("(if a then 1 else 2) + 3", "(if a then 1 else 2) + 3");
    assert_fmt("1 + (if a then 1 else 2)", "1 + (if a then 1 else 2)");
    assert_fmt("let x = 1 in let y = x in x + y", "let x = 1 in let y = x in x + y");
    assert_fmt("(let x = [1] in x)[0]", "(let x = [1] in x)[0]");
    assert_fmt("[if a then 1 else 2, (3)]", "[if a then 1 else 2, 3]");
}

#[test]
fn calls_lists_and_indexing() {
    assert_fmt("max( 1 ,2, )", "max(1, 2)");
    assert_fmt("[[1], [2, 3]][1][0]", "[[1], [2, 3]][1][0]");
    assert_fmt("[]", "[]");
    assert_fmt("f()", "f()");
}

#[test]
fn literals_round_trip() {
    assert_fmt("2.0", "2.0");
    assert_fmt("0.125", "0.125");
    assert_fmt(r#""tab\there \"q\"""#, r#""tab\there \"q\"""#);
}

#[test]
fn comparison_cannot_be_chained() {
    assert_eq!(fmt("a < b < c"), "syntax error at 1:7: `<` cannot be chained with `<`; add parentheses");
    assert_eq!(fmt("a == b != c"), "syntax error at 1:8: `==` cannot be chained with `!=`; add parentheses");
    assert_fmt("(a < b) == c", "(a < b) == c");
}

#[test]
fn syntax_errors() {
    assert_eq!(fmt("1 +"), "syntax error at 1:4: expected an expression, found end of input");
    assert_eq!(fmt("if a then b"), "syntax error at 1:12: expected `else`, found end of input");
    assert_eq!(fmt("let 1 = 2 in 3"), "syntax error at 1:5: expected a name after `let`, found number `1`");
    assert_eq!(fmt("(1 + 2"), "syntax error at 1:7: expected `)`, found end of input");
    assert_eq!(fmt("1 2"), "syntax error at 1:3: expected end of input, found number `2`");
    assert_eq!(fmt("[1, 2"), "syntax error at 1:6: expected `]`, found end of input");
    assert_eq!(fmt("* 2"), "syntax error at 1:1: expected an expression, found `*`");
}
