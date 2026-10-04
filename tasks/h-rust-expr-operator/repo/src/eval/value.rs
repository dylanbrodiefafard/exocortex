//! Runtime values.

use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Int(i64),
    Float(f64),
    Bool(bool),
    Str(String),
    List(Vec<Value>),
}

impl Value {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Int(n) => Some(*n as f64),
            Value::Float(x) => Some(*x),
            _ => None,
        }
    }
}

/// Floats always show a decimal point or an exponent so they read back as
/// floats: `2.0`, `0.5`, `1e300`.
pub fn format_float(x: f64) -> String {
    let text = format!("{x:?}");
    if text.contains(['.', 'e', 'i', 'N']) {
        text
    } else {
        format!("{text}.0")
    }
}

/// A string literal that reads back as `s`.
pub fn quote_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Values print as literals: `3`, `2.5`, `true`, `"text"`, `[1, 2]`.
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Int(n) => write!(f, "{n}"),
            Value::Float(x) => f.write_str(&format_float(*x)),
            Value::Bool(b) => write!(f, "{b}"),
            Value::Str(s) => f.write_str(&quote_str(s)),
            Value::List(items) => {
                f.write_str("[")?;
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{item}")?;
                }
                f.write_str("]")
            }
        }
    }
}
