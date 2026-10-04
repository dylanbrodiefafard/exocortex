//! Tokens produced by the lexer.

use std::fmt;

use crate::span::Span;

#[derive(Clone, Debug, PartialEq)]
pub enum TokenKind {
    Int(i64),
    Float(f64),
    Str(String),
    Ident(String),
    // Keywords.
    True,
    False,
    Let,
    In,
    If,
    Then,
    Else,
    And,
    Or,
    Not,
    // Punctuation.
    Plus,
    PlusPlus,
    Minus,
    Star,
    Slash,
    Percent,
    EqEq,
    BangEq,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Eof,
}

impl TokenKind {
    /// The keyword spelled `word`, if any.
    pub fn keyword(word: &str) -> Option<TokenKind> {
        Some(match word {
            "true" => TokenKind::True,
            "false" => TokenKind::False,
            "let" => TokenKind::Let,
            "in" => TokenKind::In,
            "if" => TokenKind::If,
            "then" => TokenKind::Then,
            "else" => TokenKind::Else,
            "and" => TokenKind::And,
            "or" => TokenKind::Or,
            "not" => TokenKind::Not,
            _ => return None,
        })
    }
}

/// How a token is named in error messages: `` `+` ``, `` `then` ``,
/// `identifier `x``, `end of input`.
impl fmt::Display for TokenKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            TokenKind::Int(n) => return write!(f, "number `{n}`"),
            TokenKind::Float(x) => return write!(f, "number `{x}`"),
            TokenKind::Str(_) => return f.write_str("string"),
            TokenKind::Ident(name) => return write!(f, "identifier `{name}`"),
            TokenKind::Eof => return f.write_str("end of input"),
            TokenKind::True => "true",
            TokenKind::False => "false",
            TokenKind::Let => "let",
            TokenKind::In => "in",
            TokenKind::If => "if",
            TokenKind::Then => "then",
            TokenKind::Else => "else",
            TokenKind::And => "and",
            TokenKind::Or => "or",
            TokenKind::Not => "not",
            TokenKind::Plus => "+",
            TokenKind::PlusPlus => "++",
            TokenKind::Minus => "-",
            TokenKind::Star => "*",
            TokenKind::Slash => "/",
            TokenKind::Percent => "%",
            TokenKind::EqEq => "==",
            TokenKind::BangEq => "!=",
            TokenKind::Lt => "<",
            TokenKind::Le => "<=",
            TokenKind::Gt => ">",
            TokenKind::Ge => ">=",
            TokenKind::Eq => "=",
            TokenKind::LParen => "(",
            TokenKind::RParen => ")",
            TokenKind::LBracket => "[",
            TokenKind::RBracket => "]",
            TokenKind::Comma => ",",
        };
        write!(f, "`{text}`")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}
