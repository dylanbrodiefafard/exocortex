//! The type checker. Every program is checked before it runs, so the
//! evaluator never sees an ill-typed operation.
//!
//! Errors about an operator point at the operator token; other errors point
//! at the offending expression.

use crate::builtins;
use crate::error::{Error, Result};
use crate::syntax::ast::{Expr, ExprKind};
use crate::syntax::ops::{BinOp, UnOp};
use crate::types::ty::Type;

pub fn check_program(expr: &Expr) -> Result<Type> {
    Checker { scopes: Vec::new() }.check(expr)
}

struct Checker {
    scopes: Vec<(String, Type)>,
}

impl Checker {
    fn lookup(&self, name: &str) -> Option<&Type> {
        self.scopes.iter().rev().find(|(n, _)| n == name).map(|(_, t)| t)
    }

    fn check(&mut self, expr: &Expr) -> Result<Type> {
        match &expr.kind {
            ExprKind::Int(_) => Ok(Type::Int),
            ExprKind::Float(_) => Ok(Type::Float),
            ExprKind::Str(_) => Ok(Type::Str),
            ExprKind::Bool(_) => Ok(Type::Bool),
            ExprKind::Var(name) => self
                .lookup(name)
                .cloned()
                .ok_or_else(|| Error::type_error(format!("unknown variable `{name}`"), expr.span)),
            ExprKind::List(items) => {
                let mut elem = Type::Unknown;
                for item in items {
                    let t = self.check(item)?;
                    elem = Type::unify(&elem, &t).ok_or_else(|| {
                        Error::type_error(format!("list items must have the same type, found {elem} and {t}"), item.span)
                    })?;
                }
                Ok(Type::list(elem))
            }
            ExprKind::Unary { op, op_span, operand } => {
                let t = self.check(operand)?;
                match op {
                    UnOp::Neg if t.is_numeric() => Ok(t),
                    UnOp::Neg => Err(Error::type_error(format!("operator `-` expects a number, found {t}"), *op_span)),
                    UnOp::Not if matches!(t, Type::Bool | Type::Unknown) => Ok(Type::Bool),
                    UnOp::Not => Err(Error::type_error(format!("operator `not` expects Bool, found {t}"), *op_span)),
                }
            }
            ExprKind::Binary { op, op_span, lhs, rhs } => {
                let l = self.check(lhs)?;
                let r = self.check(rhs)?;
                binary_type(*op, &l, &r).map_err(|msg| Error::type_error(msg, *op_span))
            }
            ExprKind::If { cond, then_branch, else_branch } => {
                let c = self.check(cond)?;
                if !matches!(c, Type::Bool | Type::Unknown) {
                    return Err(Error::type_error(format!("condition must be Bool, found {c}"), cond.span));
                }
                let a = self.check(then_branch)?;
                let b = self.check(else_branch)?;
                Type::unify(&a, &b).ok_or_else(|| {
                    Error::type_error(format!("`if` branches have different types: {a} and {b}"), expr.span)
                })
            }
            ExprKind::Let { name, value, body } => {
                let t = self.check(value)?;
                self.scopes.push((name.clone(), t));
                let result = self.check(body);
                self.scopes.pop();
                result
            }
            ExprKind::Call { func, func_span, args } => {
                let builtin = builtins::lookup(func)
                    .ok_or_else(|| Error::type_error(format!("unknown function `{func}`"), *func_span))?;
                if args.len() != builtin.arity {
                    let plural = if builtin.arity == 1 { "" } else { "s" };
                    return Err(Error::type_error(
                        format!("`{func}` takes {} argument{plural}, found {}", builtin.arity, args.len()),
                        expr.span,
                    ));
                }
                let types = args.iter().map(|a| self.check(a)).collect::<Result<Vec<_>>>()?;
                (builtin.check)(&types).map_err(|msg| Error::type_error(format!("`{func}`: {msg}"), expr.span))
            }
            ExprKind::Index { target, index } => {
                let t = self.check(target)?;
                let i = self.check(index)?;
                if !matches!(i, Type::Int | Type::Unknown) {
                    return Err(Error::type_error(format!("index must be Int, found {i}"), index.span));
                }
                match t {
                    Type::List(elem) => Ok(*elem),
                    Type::Str => Ok(Type::Str),
                    Type::Unknown => Ok(Type::Unknown),
                    other => Err(Error::type_error(format!("cannot index a value of type {other}"), target.span)),
                }
            }
        }
    }
}

/// The type of `l op r`, or the error message.
fn binary_type(op: BinOp, l: &Type, r: &Type) -> std::result::Result<Type, String> {
    let sym = op.symbol();
    match op {
        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod => {
            if l.is_numeric() && r.is_numeric() {
                Ok(Type::numeric_result(l, r))
            } else {
                Err(format!("operator `{sym}` expects numbers, found {l} and {r}"))
            }
        }
        BinOp::Concat => match (l, r) {
            (Type::Str | Type::Unknown, Type::Str | Type::Unknown) if *l == Type::Str || *r == Type::Str => Ok(Type::Str),
            (Type::List(_) | Type::Unknown, Type::List(_) | Type::Unknown) => Type::unify(l, r)
                .ok_or_else(|| format!("operator `++` expects two lists of the same type, found {l} and {r}")),
            _ => Err(format!("operator `++` expects two strings or two lists, found {l} and {r}")),
        },
        BinOp::Eq | BinOp::Ne => {
            let comparable = (l.is_numeric() && r.is_numeric()) || Type::unify(l, r).is_some();
            if comparable {
                Ok(Type::Bool)
            } else {
                Err(format!("cannot compare {l} with {r}"))
            }
        }
        BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
            let ok = (l.is_numeric() && r.is_numeric()) || (matches!(l, Type::Str | Type::Unknown) && matches!(r, Type::Str | Type::Unknown));
            if ok {
                Ok(Type::Bool)
            } else {
                Err(format!("operator `{sym}` expects two numbers or two strings, found {l} and {r}"))
            }
        }
        BinOp::And | BinOp::Or => {
            if matches!(l, Type::Bool | Type::Unknown) && matches!(r, Type::Bool | Type::Unknown) {
                Ok(Type::Bool)
            } else {
                Err(format!("operator `{sym}` expects Bool operands, found {l} and {r}"))
            }
        }
    }
}
