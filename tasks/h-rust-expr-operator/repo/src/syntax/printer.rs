//! Printing a syntax tree as canonical source text.
//!
//! Binary operators are surrounded by single spaces, list items and call
//! arguments are separated by `, `, and parentheses are written only where
//! they are needed for the text to parse back to the same tree. The one
//! exception: an `if` or `let` that is an operand (of an operator, or the
//! target of indexing) is always parenthesized.

use crate::eval::value::{format_float, quote_str};
use crate::syntax::ast::{Expr, ExprKind};
use crate::syntax::ops::{self, Assoc, UnOp, POSTFIX_PREC, UNARY_PREC};

pub fn print(expr: &Expr) -> String {
    let mut out = String::new();
    write_expr(expr, &mut out);
    out
}

/// The precedence an expression has as an operand.
fn prec(expr: &Expr) -> u8 {
    match &expr.kind {
        ExprKind::Binary { op, .. } => ops::info(*op).prec,
        ExprKind::Unary { .. } => UNARY_PREC,
        ExprKind::If { .. } | ExprKind::Let { .. } => 0,
        _ => POSTFIX_PREC,
    }
}

fn is_open(expr: &Expr) -> bool {
    matches!(expr.kind, ExprKind::If { .. } | ExprKind::Let { .. })
}

fn write_operand(expr: &Expr, parens: bool, out: &mut String) {
    if parens {
        out.push('(');
        write_expr(expr, out);
        out.push(')');
    } else {
        write_expr(expr, out);
    }
}

fn write_list(items: &[Expr], out: &mut String) {
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        write_expr(item, out);
    }
}

fn write_expr(expr: &Expr, out: &mut String) {
    match &expr.kind {
        ExprKind::Int(n) => out.push_str(&n.to_string()),
        ExprKind::Float(x) => out.push_str(&format_float(*x)),
        ExprKind::Str(s) => out.push_str(&quote_str(s)),
        ExprKind::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        ExprKind::Var(name) => out.push_str(name),
        ExprKind::List(items) => {
            out.push('[');
            write_list(items, out);
            out.push(']');
        }
        ExprKind::Call { func, args, .. } => {
            out.push_str(func);
            out.push('(');
            write_list(args, out);
            out.push(')');
        }
        ExprKind::Index { target, index } => {
            write_operand(target, prec(target) < POSTFIX_PREC, out);
            out.push('[');
            write_expr(index, out);
            out.push(']');
        }
        ExprKind::Unary { op, operand, .. } => {
            out.push_str(op.symbol());
            if *op == UnOp::Not {
                out.push(' ');
            }
            write_operand(operand, is_open(operand) || prec(operand) < UNARY_PREC, out);
        }
        ExprKind::Binary { op, lhs, rhs, .. } => {
            let info = ops::info(*op);
            let left_parens =
                is_open(lhs) || prec(lhs) < info.prec || (prec(lhs) == info.prec && info.assoc != Assoc::Left);
            let right_parens =
                is_open(rhs) || prec(rhs) < info.prec || (prec(rhs) == info.prec && info.assoc != Assoc::Right);
            write_operand(lhs, left_parens, out);
            out.push(' ');
            out.push_str(info.symbol);
            out.push(' ');
            write_operand(rhs, right_parens, out);
        }
        ExprKind::If { cond, then_branch, else_branch } => {
            out.push_str("if ");
            write_expr(cond, out);
            out.push_str(" then ");
            write_expr(then_branch, out);
            out.push_str(" else ");
            write_expr(else_branch, out);
        }
        ExprKind::Let { name, value, body } => {
            out.push_str("let ");
            out.push_str(name);
            out.push_str(" = ");
            write_expr(value, out);
            out.push_str(" in ");
            write_expr(body, out);
        }
    }
}
