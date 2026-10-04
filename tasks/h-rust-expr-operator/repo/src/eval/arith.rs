//! Arithmetic shared by the operators and the builtins.
//!
//! Integer arithmetic is checked: a result that does not fit in an `i64` is
//! an [`ArithError::Overflow`], never a wrap-around. Float arithmetic must
//! produce a finite number. Mixing an `Int` with a `Float` converts the
//! `Int` to `Float` first.

use std::fmt;

use crate::eval::value::Value;
use crate::syntax::ops::BinOp;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArithError {
    Overflow,
    DivisionByZero,
    NegativeExponent,
    NotFinite,
}

impl fmt::Display for ArithError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ArithError::Overflow => "integer overflow",
            ArithError::DivisionByZero => "division by zero",
            ArithError::NegativeExponent => "negative exponent in integer power",
            ArithError::NotFinite => "result is not a finite number",
        })
    }
}

pub type ArithResult<T> = Result<T, ArithError>;

/// Checks that a float result is finite.
pub fn finite(x: f64) -> ArithResult<f64> {
    if x.is_finite() {
        Ok(x)
    } else {
        Err(ArithError::NotFinite)
    }
}

fn int_op(op: BinOp, a: i64, b: i64) -> ArithResult<i64> {
    let result = match op {
        BinOp::Add => a.checked_add(b),
        BinOp::Sub => a.checked_sub(b),
        BinOp::Mul => a.checked_mul(b),
        BinOp::Div | BinOp::Mod if b == 0 => return Err(ArithError::DivisionByZero),
        BinOp::Div => a.checked_div(b),
        BinOp::Mod => a.checked_rem(b),
        _ => unreachable!("{op:?} is not arithmetic"),
    };
    result.ok_or(ArithError::Overflow)
}

fn float_op(op: BinOp, a: f64, b: f64) -> ArithResult<f64> {
    match op {
        BinOp::Add => finite(a + b),
        BinOp::Sub => finite(a - b),
        BinOp::Mul => finite(a * b),
        BinOp::Div | BinOp::Mod if b == 0.0 => Err(ArithError::DivisionByZero),
        BinOp::Div => finite(a / b),
        BinOp::Mod => finite(a % b),
        _ => unreachable!("{op:?} is not arithmetic"),
    }
}

/// `a op b` for an arithmetic operator (`+ - * / %`).
pub fn binary(op: BinOp, a: &Value, b: &Value) -> ArithResult<Value> {
    match (a, b) {
        (Value::Int(x), Value::Int(y)) => int_op(op, *x, *y).map(Value::Int),
        _ => {
            let x = a.as_f64().expect("type checker guarantees numbers");
            let y = b.as_f64().expect("type checker guarantees numbers");
            float_op(op, x, y).map(Value::Float)
        }
    }
}

/// `a` raised to the power `b`. `Int` to an `Int` power is an `Int`; the
/// exponent must not be negative. Otherwise both are converted to `Float`.
pub fn power(a: &Value, b: &Value) -> ArithResult<Value> {
    match (a, b) {
        (Value::Int(base), Value::Int(exp)) => int_pow(*base, *exp).map(Value::Int),
        _ => {
            let x = a.as_f64().expect("type checker guarantees numbers");
            let y = b.as_f64().expect("type checker guarantees numbers");
            finite(x.powf(y)).map(Value::Float)
        }
    }
}

fn int_pow(base: i64, exp: i64) -> ArithResult<i64> {
    if exp < 0 {
        return Err(ArithError::NegativeExponent);
    }
    match base {
        0 => return Ok(if exp == 0 { 1 } else { 0 }),
        1 => return Ok(1),
        -1 => return Ok(if exp % 2 == 0 { 1 } else { -1 }),
        _ => {}
    }
    let exp = u32::try_from(exp).map_err(|_| ArithError::Overflow)?;
    base.checked_pow(exp).ok_or(ArithError::Overflow)
}

/// Absolute value.
pub fn abs(a: &Value) -> ArithResult<Value> {
    match a {
        Value::Int(n) => n.checked_abs().map(Value::Int).ok_or(ArithError::Overflow),
        Value::Float(x) => Ok(Value::Float(x.abs())),
        _ => unreachable!("type checker guarantees a number"),
    }
}

/// Negation.
pub fn negate(a: &Value) -> ArithResult<Value> {
    match a {
        Value::Int(n) => n.checked_neg().map(Value::Int).ok_or(ArithError::Overflow),
        Value::Float(x) => Ok(Value::Float(-x)),
        _ => unreachable!("type checker guarantees a number"),
    }
}

/// Sum of a list of numbers; `Int` unless an item is a `Float`.
pub fn sum(items: &[Value]) -> ArithResult<Value> {
    items.iter().try_fold(Value::Int(0), |acc, item| binary(BinOp::Add, &acc, item))
}
