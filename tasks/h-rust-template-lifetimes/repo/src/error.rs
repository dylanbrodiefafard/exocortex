use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// Malformed template text. `line` is 1-based.
    Syntax {
        line: usize,
        msg: String,
    },
    /// A `{{ }}`, `if` or `for` referred to a path that is not in the context.
    MissingValue {
        line: usize,
        path: String,
    },
    /// A value of the wrong type, e.g. `for` over a string or `{{ }}` of a list.
    Type {
        line: usize,
        msg: String,
    },
    UnknownFilter {
        line: usize,
        name: String,
    },
    UnknownTemplate(String),
    /// Includes nested deeper than [`crate::Engine::MAX_DEPTH`] (usually a cycle).
    IncludeDepth(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Syntax { line, msg } => write!(f, "line {line}: syntax error: {msg}"),
            Error::MissingValue { line, path } => write!(f, "line {line}: no value for `{path}`"),
            Error::Type { line, msg } => write!(f, "line {line}: {msg}"),
            Error::UnknownFilter { line, name } => {
                write!(f, "line {line}: unknown filter `{name}`")
            }
            Error::UnknownTemplate(name) => write!(f, "unknown template `{name}`"),
            Error::IncludeDepth(name) => write!(f, "includes nested too deeply at `{name}`"),
        }
    }
}

impl std::error::Error for Error {}
