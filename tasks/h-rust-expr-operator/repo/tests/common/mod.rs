#![allow(dead_code)]

use rill::syntax::ast::{Expr, ExprKind};

/// The printed value, or the rendered error.
pub fn run(src: &str) -> String {
    match rill::eval(src) {
        Ok(v) => v.to_string(),
        Err(e) => e.render(src),
    }
}

/// The type, or the rendered error.
pub fn ty(src: &str) -> String {
    match rill::check(src) {
        Ok(t) => t.to_string(),
        Err(e) => e.render(src),
    }
}

/// The formatted source, or the rendered error.
pub fn fmt(src: &str) -> String {
    match rill::format(src) {
        Ok(s) => s,
        Err(e) => e.render(src),
    }
}

/// Whether two trees are equal ignoring spans.
pub fn same_tree(a: &Expr, b: &Expr) -> bool {
    use ExprKind::*;
    match (&a.kind, &b.kind) {
        (Int(x), Int(y)) => x == y,
        (Float(x), Float(y)) => x == y,
        (Str(x), Str(y)) => x == y,
        (Bool(x), Bool(y)) => x == y,
        (Var(x), Var(y)) => x == y,
        (List(xs), List(ys)) => xs.len() == ys.len() && xs.iter().zip(ys).all(|(x, y)| same_tree(x, y)),
        (Unary { op: o1, operand: a1, .. }, Unary { op: o2, operand: a2, .. }) => o1 == o2 && same_tree(a1, a2),
        (Binary { op: o1, lhs: l1, rhs: r1, .. }, Binary { op: o2, lhs: l2, rhs: r2, .. }) => {
            o1 == o2 && same_tree(l1, l2) && same_tree(r1, r2)
        }
        (If { cond: c1, then_branch: t1, else_branch: e1 }, If { cond: c2, then_branch: t2, else_branch: e2 }) => {
            same_tree(c1, c2) && same_tree(t1, t2) && same_tree(e1, e2)
        }
        (Let { name: n1, value: v1, body: b1 }, Let { name: n2, value: v2, body: b2 }) => {
            n1 == n2 && same_tree(v1, v2) && same_tree(b1, b2)
        }
        (Call { func: f1, args: a1, .. }, Call { func: f2, args: a2, .. }) => {
            f1 == f2 && a1.len() == a2.len() && a1.iter().zip(a2).all(|(x, y)| same_tree(x, y))
        }
        (Index { target: t1, index: i1 }, Index { target: t2, index: i2 }) => same_tree(t1, t2) && same_tree(i1, i2),
        _ => false,
    }
}

/// Asserts that formatting `src` gives `want`, that formatting is
/// idempotent and that the output parses to the same tree as `src`.
pub fn assert_fmt(src: &str, want: &str) {
    let got = rill::format(src).unwrap_or_else(|e| panic!("format({src:?}): {}", e.render(src)));
    assert_eq!(got, want, "format({src:?})");
    let again = rill::format(&got).expect("formatted output parses");
    assert_eq!(again, got, "format is not idempotent for {src:?}");
    let original = rill::parse(src).unwrap();
    let reparsed = rill::parse(&got).unwrap();
    assert!(same_tree(&original, &reparsed), "format({src:?}) = {got:?} changes the meaning");
}
