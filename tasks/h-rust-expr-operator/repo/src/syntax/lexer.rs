//! Turning source text into tokens.
//!
//! Whitespace separates tokens and `#` starts a comment that runs to the end
//! of the line. Integer literals are decimal digits; float literals have
//! digits on both sides of the `.`. Strings are double-quoted and support
//! the escapes `\n`, `\t`, `\"` and `\\`. There are no negative literals:
//! `-1` is the `-` operator applied to `1`.

use crate::error::{Error, Result};
use crate::span::Span;
use crate::syntax::token::{Token, TokenKind};

pub fn tokenize(src: &str) -> Result<Vec<Token>> {
    Lexer { src, pos: 0, tokens: Vec::new() }.run()
}

struct Lexer<'a> {
    src: &'a str,
    pos: usize,
    tokens: Vec<Token>,
}

impl<'a> Lexer<'a> {
    fn peek(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    fn peek_second(&self) -> Option<char> {
        let mut chars = self.src[self.pos..].chars();
        chars.next();
        chars.next()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn push(&mut self, kind: TokenKind, start: usize) {
        self.tokens.push(Token { kind, span: Span::new(start, self.pos) });
    }

    fn run(mut self) -> Result<Vec<Token>> {
        while let Some(c) = self.peek() {
            let start = self.pos;
            if c.is_whitespace() {
                self.bump();
            } else if c == '#' {
                while let Some(c) = self.bump() {
                    if c == '\n' {
                        break;
                    }
                }
            } else if c.is_ascii_digit() {
                self.number(start)?;
            } else if c.is_alphabetic() || c == '_' {
                self.word(start);
            } else if c == '"' {
                self.string(start)?;
            } else {
                self.punct(start)?;
            }
        }
        let end = self.src.len();
        self.tokens.push(Token { kind: TokenKind::Eof, span: Span::new(end, end) });
        Ok(self.tokens)
    }

    fn number(&mut self, start: usize) -> Result<()> {
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.bump();
        }
        let is_float = self.peek() == Some('.') && self.peek_second().is_some_and(|c| c.is_ascii_digit());
        if is_float {
            self.bump();
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.bump();
            }
            let text = &self.src[start..self.pos];
            let value: f64 = text.parse().expect("digits.digits is a valid float");
            self.push(TokenKind::Float(value), start);
            return Ok(());
        }
        let text = &self.src[start..self.pos];
        match text.parse::<i64>() {
            Ok(n) => {
                self.push(TokenKind::Int(n), start);
                Ok(())
            }
            Err(_) => Err(Error::syntax("integer literal is too large", Span::new(start, self.pos))),
        }
    }

    fn word(&mut self, start: usize) {
        while self.peek().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            self.bump();
        }
        let text = &self.src[start..self.pos];
        let kind = TokenKind::keyword(text).unwrap_or_else(|| TokenKind::Ident(text.to_string()));
        self.push(kind, start);
    }

    fn string(&mut self, start: usize) -> Result<()> {
        self.bump();
        let mut value = String::new();
        loop {
            let escape_start = self.pos;
            match self.bump() {
                None | Some('\n') => {
                    return Err(Error::syntax("unterminated string", Span::new(start, self.pos)));
                }
                Some('"') => break,
                Some('\\') => {
                    let c = self.bump();
                    value.push(match c {
                        Some('n') => '\n',
                        Some('t') => '\t',
                        Some('"') => '"',
                        Some('\\') => '\\',
                        _ => {
                            let text = &self.src[escape_start..self.pos];
                            return Err(Error::syntax(
                                format!("unknown escape `{text}`"),
                                Span::new(escape_start, self.pos),
                            ));
                        }
                    });
                }
                Some(c) => value.push(c),
            }
        }
        self.push(TokenKind::Str(value), start);
        Ok(())
    }

    fn punct(&mut self, start: usize) -> Result<()> {
        let c = self.bump().expect("punct called at end of input");
        let next = self.peek();
        let kind = match (c, next) {
            ('+', Some('+')) => {
                self.bump();
                TokenKind::PlusPlus
            }
            ('=', Some('=')) => {
                self.bump();
                TokenKind::EqEq
            }
            ('!', Some('=')) => {
                self.bump();
                TokenKind::BangEq
            }
            ('<', Some('=')) => {
                self.bump();
                TokenKind::Le
            }
            ('>', Some('=')) => {
                self.bump();
                TokenKind::Ge
            }
            ('+', _) => TokenKind::Plus,
            ('-', _) => TokenKind::Minus,
            ('*', _) => TokenKind::Star,
            ('/', _) => TokenKind::Slash,
            ('%', _) => TokenKind::Percent,
            ('<', _) => TokenKind::Lt,
            ('>', _) => TokenKind::Gt,
            ('=', _) => TokenKind::Eq,
            ('(', _) => TokenKind::LParen,
            (')', _) => TokenKind::RParen,
            ('[', _) => TokenKind::LBracket,
            (']', _) => TokenKind::RBracket,
            (',', _) => TokenKind::Comma,
            _ => {
                return Err(Error::syntax(format!("unexpected character `{c}`"), Span::new(start, self.pos)));
            }
        };
        self.push(kind, start);
        Ok(())
    }
}
