use std::fmt;

/// What went wrong on a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    MissingEquals,
    UnterminatedQuote,
    InvalidSectionHeader,
    EmptyKey,
    TrailingCharacters,
}

/// A parse failure, with the 1-based line it occurred on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub line: usize,
    pub kind: ErrorKind,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let what = match self.kind {
            ErrorKind::MissingEquals => "expected `key = value`",
            ErrorKind::UnterminatedQuote => "unterminated quoted value",
            ErrorKind::InvalidSectionHeader => "invalid section header",
            ErrorKind::EmptyKey => "empty key",
            ErrorKind::TrailingCharacters => "unexpected characters after quoted value",
        };
        write!(f, "line {}: {}", self.line, what)
    }
}

impl std::error::Error for ParseError {}
