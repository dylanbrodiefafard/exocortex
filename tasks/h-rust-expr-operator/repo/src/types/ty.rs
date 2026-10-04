//! The types of rill values.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Int,
    Float,
    Bool,
    Str,
    List(Box<Type>),
    /// The element type of `[]`: compatible with every type.
    Unknown,
}

impl Type {
    pub fn list(elem: Type) -> Type {
        Type::List(Box::new(elem))
    }

    pub fn is_numeric(&self) -> bool {
        matches!(self, Type::Int | Type::Float | Type::Unknown)
    }

    /// The common type of `a` and `b`, if they are compatible. `Unknown`
    /// is compatible with everything; lists are compatible when their
    /// elements are. `Int` and `Float` are *not* compatible.
    pub fn unify(a: &Type, b: &Type) -> Option<Type> {
        match (a, b) {
            (Type::Unknown, t) | (t, Type::Unknown) => Some(t.clone()),
            (Type::List(x), Type::List(y)) => Type::unify(x, y).map(Type::list),
            (x, y) if x == y => Some(x.clone()),
            _ => None,
        }
    }

    /// The result type of arithmetic on two numeric types: `Int` if both are
    /// `Int`, otherwise `Float` (`Unknown` stays `Unknown`).
    pub fn numeric_result(a: &Type, b: &Type) -> Type {
        match (a, b) {
            (Type::Unknown, _) | (_, Type::Unknown) => Type::Unknown,
            (Type::Int, Type::Int) => Type::Int,
            _ => Type::Float,
        }
    }
}

impl fmt::Display for Type {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Type::Int => f.write_str("Int"),
            Type::Float => f.write_str("Float"),
            Type::Bool => f.write_str("Bool"),
            Type::Str => f.write_str("Str"),
            Type::List(elem) => write!(f, "List[{elem}]"),
            Type::Unknown => f.write_str("?"),
        }
    }
}
