//! The evaluator. Programs are type checked first, so type mismatches here
//! are bugs, not user errors.
//!
//! Runtime errors about an operator point at the operator token, errors in
//! a builtin call at the call, and index errors at the index expression.

use crate::builtins;
use crate::error::{Error, Result};
use crate::eval::arith;
use crate::eval::value::Value;
use crate::syntax::ast::{Expr, ExprKind};
use crate::syntax::ops::{BinOp, UnOp};

pub fn eval_program(expr: &Expr) -> Result<Value> {
    Interp { scopes: Vec::new() }.eval(expr)
}

struct Interp {
    scopes: Vec<(String, Value)>,
}

impl Interp {
    fn eval(&mut self, expr: &Expr) -> Result<Value> {
        match &expr.kind {
            ExprKind::Int(n) => Ok(Value::Int(*n)),
            ExprKind::Float(x) => Ok(Value::Float(*x)),
            ExprKind::Str(s) => Ok(Value::Str(s.clone())),
            ExprKind::Bool(b) => Ok(Value::Bool(*b)),
            ExprKind::Var(name) => Ok(self
                .scopes
                .iter()
                .rev()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
                .expect("type checker guarantees variables are bound")),
            ExprKind::List(items) => Ok(Value::List(items.iter().map(|i| self.eval(i)).collect::<Result<_>>()?)),
            ExprKind::Unary { op, op_span, operand } => {
                let v = self.eval(operand)?;
                match op {
                    UnOp::Neg => arith::negate(&v).map_err(|e| Error::runtime(e.to_string(), *op_span)),
                    UnOp::Not => match v {
                        Value::Bool(b) => Ok(Value::Bool(!b)),
                        other => unreachable!("`not` applied to {other:?}"),
                    },
                }
            }
            ExprKind::Binary { op: BinOp::And, lhs, rhs, .. } => {
                if self.eval_bool(lhs)? {
                    self.eval(rhs)
                } else {
                    Ok(Value::Bool(false))
                }
            }
            ExprKind::Binary { op: BinOp::Or, lhs, rhs, .. } => {
                if self.eval_bool(lhs)? {
                    Ok(Value::Bool(true))
                } else {
                    self.eval(rhs)
                }
            }
            ExprKind::Binary { op, op_span, lhs, rhs } => {
                let l = self.eval(lhs)?;
                let r = self.eval(rhs)?;
                binary(*op, &l, &r).map_err(|msg| Error::runtime(msg, *op_span))
            }
            ExprKind::If { cond, then_branch, else_branch } => {
                if self.eval_bool(cond)? {
                    self.eval(then_branch)
                } else {
                    self.eval(else_branch)
                }
            }
            ExprKind::Let { name, value, body } => {
                let v = self.eval(value)?;
                self.scopes.push((name.clone(), v));
                let result = self.eval(body);
                self.scopes.pop();
                result
            }
            ExprKind::Call { func, args, .. } => {
                let builtin = builtins::lookup(func).expect("type checker guarantees the function exists");
                let values = args.iter().map(|a| self.eval(a)).collect::<Result<Vec<_>>>()?;
                (builtin.call)(&values).map_err(|msg| Error::runtime(msg, expr.span))
            }
            ExprKind::Index { target, index } => {
                let t = self.eval(target)?;
                let Value::Int(i) = self.eval(index)? else { unreachable!("index is Int") };
                index_value(&t, i).map_err(|msg| Error::runtime(msg, index.span))
            }
        }
    }

    fn eval_bool(&mut self, expr: &Expr) -> Result<bool> {
        match self.eval(expr)? {
            Value::Bool(b) => Ok(b),
            other => unreachable!("expected Bool, got {other:?}"),
        }
    }
}

/// `l op r` for every operator except the short-circuiting `and`/`or`.
fn binary(op: BinOp, l: &Value, r: &Value) -> std::result::Result<Value, String> {
    match op {
        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod => {
            arith::binary(op, l, r).map_err(|e| e.to_string())
        }
        BinOp::Concat => Ok(match (l, r) {
            (Value::Str(a), Value::Str(b)) => Value::Str(format!("{a}{b}")),
            (Value::List(a), Value::List(b)) => Value::List(a.iter().chain(b).cloned().collect()),
            _ => unreachable!("`++` on {l:?} and {r:?}"),
        }),
        BinOp::Eq => Ok(Value::Bool(equal(l, r))),
        BinOp::Ne => Ok(Value::Bool(!equal(l, r))),
        BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
            let ord = compare(l, r);
            Ok(Value::Bool(match op {
                BinOp::Lt => ord.is_lt(),
                BinOp::Le => ord.is_le(),
                BinOp::Gt => ord.is_gt(),
                _ => ord.is_ge(),
            }))
        }
        BinOp::And | BinOp::Or => unreachable!("short-circuit operators are evaluated in Interp::eval"),
    }
}

/// Equality; an `Int` equals a `Float` with the same value.
fn equal(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Int(_) | Value::Float(_), Value::Int(_) | Value::Float(_)) => match (l, r) {
            (Value::Int(a), Value::Int(b)) => a == b,
            _ => l.as_f64() == r.as_f64(),
        },
        (Value::List(a), Value::List(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| equal(x, y)),
        _ => l == r,
    }
}

fn compare(l: &Value, r: &Value) -> std::cmp::Ordering {
    match (l, r) {
        (Value::Int(a), Value::Int(b)) => a.cmp(b),
        (Value::Str(a), Value::Str(b)) => a.cmp(b),
        _ => {
            let (a, b) = (l.as_f64().expect("number"), r.as_f64().expect("number"));
            a.partial_cmp(&b).expect("floats are finite")
        }
    }
}

/// `target[i]`; negative indexes count from the end.
fn index_value(target: &Value, i: i64) -> std::result::Result<Value, String> {
    let len = match target {
        Value::List(items) => items.len(),
        Value::Str(s) => s.chars().count(),
        other => unreachable!("indexing {other:?}"),
    };
    let pos = if i < 0 { i + len as i64 } else { i };
    if pos < 0 || pos >= len as i64 {
        return Err(format!("index {i} is out of range for length {len}"));
    }
    let pos = pos as usize;
    Ok(match target {
        Value::List(items) => items[pos].clone(),
        Value::Str(s) => Value::Str(s.chars().nth(pos).expect("in range").to_string()),
        _ => unreachable!(),
    })
}
