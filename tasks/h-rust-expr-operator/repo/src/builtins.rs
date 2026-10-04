//! Builtin functions: the registry the type checker and the evaluator both
//! consult. Each builtin has a fixed arity, a type rule and an
//! implementation. Type rules return a message without the function name;
//! the checker adds it.

use crate::eval::arith;
use crate::eval::value::Value;
use crate::types::ty::Type;

pub struct Builtin {
    pub name: &'static str,
    /// Shown in docs: `len(Str | List[T]) -> Int`.
    pub signature: &'static str,
    pub arity: usize,
    pub check: fn(&[Type]) -> Result<Type, String>,
    pub call: fn(&[Value]) -> Result<Value, String>,
}

pub static BUILTINS: &[Builtin] = &[
    Builtin { name: "len", signature: "len(Str | List[T]) -> Int", arity: 1, check: check_len, call: call_len },
    Builtin { name: "abs", signature: "abs(N) -> N", arity: 1, check: check_numeric_unary, call: call_abs },
    Builtin { name: "min", signature: "min(A, B) -> Int | Float", arity: 2, check: check_numeric_binary, call: call_min },
    Builtin { name: "max", signature: "max(A, B) -> Int | Float", arity: 2, check: check_numeric_binary, call: call_max },
    Builtin { name: "pow", signature: "pow(A, B) -> Int | Float", arity: 2, check: check_numeric_binary, call: call_pow },
    Builtin { name: "sum", signature: "sum(List[N]) -> N", arity: 1, check: check_sum, call: call_sum },
    Builtin { name: "str", signature: "str(T) -> Str", arity: 1, check: |_| Ok(Type::Str), call: call_str },
    Builtin { name: "int", signature: "int(Int | Float | Str) -> Int", arity: 1, check: check_int, call: call_int },
    Builtin { name: "float", signature: "float(Int | Float | Str) -> Float", arity: 1, check: check_float, call: call_float },
    Builtin { name: "upper", signature: "upper(Str) -> Str", arity: 1, check: check_str, call: call_upper },
    Builtin { name: "lower", signature: "lower(Str) -> Str", arity: 1, check: check_str, call: call_lower },
    Builtin { name: "range", signature: "range(Int, Int) -> List[Int]", arity: 2, check: check_range, call: call_range },
];

pub fn lookup(name: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|b| b.name == name)
}

fn check_len(args: &[Type]) -> Result<Type, String> {
    match &args[0] {
        Type::Str | Type::List(_) | Type::Unknown => Ok(Type::Int),
        t => Err(format!("expected Str or a list, found {t}")),
    }
}

fn check_numeric_unary(args: &[Type]) -> Result<Type, String> {
    if args[0].is_numeric() {
        Ok(args[0].clone())
    } else {
        Err(format!("expected a number, found {}", args[0]))
    }
}

fn check_numeric_binary(args: &[Type]) -> Result<Type, String> {
    if args[0].is_numeric() && args[1].is_numeric() {
        Ok(Type::numeric_result(&args[0], &args[1]))
    } else {
        Err(format!("expected numbers, found {} and {}", args[0], args[1]))
    }
}

fn check_sum(args: &[Type]) -> Result<Type, String> {
    match &args[0] {
        Type::List(elem) if elem.is_numeric() => Ok(match **elem {
            Type::Unknown => Type::Int,
            ref t => t.clone(),
        }),
        t => Err(format!("expected a list of numbers, found {t}")),
    }
}

fn check_int(args: &[Type]) -> Result<Type, String> {
    match &args[0] {
        Type::Int | Type::Float | Type::Str | Type::Unknown => Ok(Type::Int),
        t => Err(format!("cannot convert {t} to Int")),
    }
}

fn check_float(args: &[Type]) -> Result<Type, String> {
    match &args[0] {
        Type::Int | Type::Float | Type::Str | Type::Unknown => Ok(Type::Float),
        t => Err(format!("cannot convert {t} to Float")),
    }
}

fn check_str(args: &[Type]) -> Result<Type, String> {
    match &args[0] {
        Type::Str | Type::Unknown => Ok(Type::Str),
        t => Err(format!("expected Str, found {t}")),
    }
}

fn check_range(args: &[Type]) -> Result<Type, String> {
    match (&args[0], &args[1]) {
        (Type::Int | Type::Unknown, Type::Int | Type::Unknown) => Ok(Type::list(Type::Int)),
        (a, b) => Err(format!("expected Int bounds, found {a} and {b}")),
    }
}

fn call_len(args: &[Value]) -> Result<Value, String> {
    Ok(Value::Int(match &args[0] {
        Value::Str(s) => s.chars().count() as i64,
        Value::List(items) => items.len() as i64,
        v => unreachable!("len({v:?})"),
    }))
}

fn call_abs(args: &[Value]) -> Result<Value, String> {
    arith::abs(&args[0]).map_err(|e| e.to_string())
}

fn pick(args: &[Value], want_max: bool) -> Value {
    let (a, b) = (&args[0], &args[1]);
    let a_wins = match (a, b) {
        (Value::Int(x), Value::Int(y)) => (x >= y) == want_max,
        _ => (a.as_f64() >= b.as_f64()) == want_max,
    };
    let winner = if a_wins { a } else { b };
    match (a, b) {
        (Value::Int(_), Value::Int(_)) => winner.clone(),
        _ => Value::Float(winner.as_f64().expect("number")),
    }
}

fn call_min(args: &[Value]) -> Result<Value, String> {
    Ok(pick(args, false))
}

fn call_max(args: &[Value]) -> Result<Value, String> {
    Ok(pick(args, true))
}

fn call_pow(args: &[Value]) -> Result<Value, String> {
    arith::power(&args[0], &args[1]).map_err(|e| e.to_string())
}

fn call_sum(args: &[Value]) -> Result<Value, String> {
    let Value::List(items) = &args[0] else { unreachable!("sum of a non-list") };
    arith::sum(items).map_err(|e| e.to_string())
}

fn call_str(args: &[Value]) -> Result<Value, String> {
    Ok(Value::Str(match &args[0] {
        Value::Str(s) => s.clone(),
        other => other.to_string(),
    }))
}

fn call_int(args: &[Value]) -> Result<Value, String> {
    match &args[0] {
        Value::Int(n) => Ok(Value::Int(*n)),
        Value::Float(x) => {
            let t = x.trunc();
            if t >= -9.223372036854776e18 && t < 9.223372036854776e18 {
                Ok(Value::Int(t as i64))
            } else {
                Err(arith::ArithError::Overflow.to_string())
            }
        }
        Value::Str(s) => s.trim().parse().map(Value::Int).map_err(|_| format!("cannot convert {s:?} to Int")),
        v => unreachable!("int({v:?})"),
    }
}

fn call_float(args: &[Value]) -> Result<Value, String> {
    match &args[0] {
        Value::Int(n) => Ok(Value::Float(*n as f64)),
        Value::Float(x) => Ok(Value::Float(*x)),
        Value::Str(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .map(Value::Float)
            .ok_or_else(|| format!("cannot convert {s:?} to Float")),
        v => unreachable!("float({v:?})"),
    }
}

fn call_upper(args: &[Value]) -> Result<Value, String> {
    let Value::Str(s) = &args[0] else { unreachable!() };
    Ok(Value::Str(s.to_uppercase()))
}

fn call_lower(args: &[Value]) -> Result<Value, String> {
    let Value::Str(s) = &args[0] else { unreachable!() };
    Ok(Value::Str(s.to_lowercase()))
}

const MAX_RANGE: i64 = 1_000_000;

fn call_range(args: &[Value]) -> Result<Value, String> {
    let (Value::Int(lo), Value::Int(hi)) = (&args[0], &args[1]) else { unreachable!() };
    if hi.saturating_sub(*lo) > MAX_RANGE {
        return Err(format!("range of more than {MAX_RANGE} items"));
    }
    Ok(Value::List((*lo..*hi).map(Value::Int).collect()))
}
