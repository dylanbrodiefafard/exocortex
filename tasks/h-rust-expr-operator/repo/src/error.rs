//! Errors from every stage, with the location they refer to.

use std::fmt;

use crate::span::{line_col, Span};

/// The stage that rejected the program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// The lexer or the parser.
    Syntax,
    /// The type checker.
    Type,
    /// Evaluation.
    Runtime,
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ErrorKind::Syntax => "syntax",
            ErrorKind::Type => "type",
            ErrorKind::Runtime => "runtime",
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
    pub span: Span,
}

impl Error {
    pub fn syntax(message: impl Into<String>, span: Span) -> Error {
        Error { kind: ErrorKind::Syntax, message: message.into(), span }
    }

    pub fn type_error(message: impl Into<String>, span: Span) -> Error {
        Error { kind: ErrorKind::Type, message: message.into(), span }
    }

    pub fn runtime(message: impl Into<String>, span: Span) -> Error {
        Error { kind: ErrorKind::Runtime, message: message.into(), span }
    }

    /// `"<kind> error at <line>:<col>: <message>"`, with the position of the
    /// start of the span in `src`.
    pub fn render(&self, src: &str) -> String {
        let (line, col) = line_col(src, self.span.start);
        format!("{} error at {}:{}: {}", self.kind, line, col, self.message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} error: {}", self.kind, self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
