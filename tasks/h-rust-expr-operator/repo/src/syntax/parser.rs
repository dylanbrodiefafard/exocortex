//! Building the syntax tree: a precedence-climbing parser driven by
//! [`ops::BINARY_OPS`](crate::syntax::ops::BINARY_OPS).
//!
//! ```text
//! expr    := prefix (binop expr)*          precedence and associativity from the table
//! prefix  := ("-" | "not") expr(UNARY_PREC)
//!          | "if" expr "then" expr "else" expr
//!          | "let" IDENT "=" expr "in" expr
//!          | postfix
//! postfix := atom ("[" expr "]")*
//! atom    := INT | FLOAT | STRING | "true" | "false" | IDENT | IDENT "(" args ")"
//!          | "(" expr ")" | "[" args "]"
//! ```
//!
//! `if` and `let` extend as far to the right as possible.

use crate::error::{Error, Result};
use crate::span::Span;
use crate::syntax::ast::{Expr, ExprKind};
use crate::syntax::ops::{self, Assoc, UnOp};
use crate::syntax::token::{Token, TokenKind};

/// Parses a whole program. `tokens` must end with [`TokenKind::Eof`].
pub fn parse(tokens: &[Token]) -> Result<Expr> {
    let mut p = Parser { tokens, pos: 0 };
    let expr = p.expr(0)?;
    let tok = p.peek();
    if tok.kind != TokenKind::Eof {
        return Err(Error::syntax(format!("expected end of input, found {}", tok.kind), tok.span));
    }
    Ok(expr)
}

struct Parser<'t> {
    tokens: &'t [Token],
    pos: usize,
}

impl<'t> Parser<'t> {
    fn peek(&self) -> &'t Token {
        &self.tokens[self.pos.min(self.tokens.len() - 1)]
    }

    fn advance(&mut self) -> &'t Token {
        let tok = self.peek();
        if tok.kind != TokenKind::Eof {
            self.pos += 1;
        }
        tok
    }

    fn eat(&mut self, kind: &TokenKind) -> bool {
        if &self.peek().kind == kind {
            self.advance();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, kind: TokenKind) -> Result<&'t Token> {
        let tok = self.peek();
        if tok.kind == kind {
            Ok(self.advance())
        } else {
            Err(Error::syntax(format!("expected {}, found {}", kind, tok.kind), tok.span))
        }
    }

    fn expr(&mut self, min_prec: u8) -> Result<Expr> {
        let mut lhs = self.prefix()?;
        while let Some(info) = ops::binary_op(&self.peek().kind) {
            if info.prec < min_prec {
                break;
            }
            let op_span = self.advance().span;
            let next_min = match info.assoc {
                Assoc::Left | Assoc::None => info.prec + 1,
                Assoc::Right => info.prec,
            };
            let rhs = self.expr(next_min)?;
            if info.assoc == Assoc::None {
                if let Some(next) = ops::binary_op(&self.peek().kind) {
                    if next.prec == info.prec {
                        return Err(Error::syntax(
                            format!("`{}` cannot be chained with `{}`; add parentheses", info.symbol, next.symbol),
                            self.peek().span,
                        ));
                    }
                }
            }
            let span = lhs.span.to(rhs.span);
            lhs = Expr::new(
                ExprKind::Binary { op: info.op, op_span, lhs: Box::new(lhs), rhs: Box::new(rhs) },
                span,
            );
        }
        Ok(lhs)
    }

    fn prefix(&mut self) -> Result<Expr> {
        let tok = self.peek();
        match tok.kind {
            TokenKind::Minus | TokenKind::Not => {
                self.advance();
                let op = if tok.kind == TokenKind::Minus { UnOp::Neg } else { UnOp::Not };
                let operand = self.expr(ops::UNARY_PREC)?;
                let span = tok.span.to(operand.span);
                Ok(Expr::new(ExprKind::Unary { op, op_span: tok.span, operand: Box::new(operand) }, span))
            }
            TokenKind::If => {
                self.advance();
                let cond = self.expr(0)?;
                self.expect(TokenKind::Then)?;
                let then_branch = self.expr(0)?;
                self.expect(TokenKind::Else)?;
                let else_branch = self.expr(0)?;
                let span = tok.span.to(else_branch.span);
                Ok(Expr::new(
                    ExprKind::If {
                        cond: Box::new(cond),
                        then_branch: Box::new(then_branch),
                        else_branch: Box::new(else_branch),
                    },
                    span,
                ))
            }
            TokenKind::Let => {
                self.advance();
                let name_tok = self.advance();
                let TokenKind::Ident(name) = &name_tok.kind else {
                    return Err(Error::syntax(format!("expected a name after `let`, found {}", name_tok.kind), name_tok.span));
                };
                self.expect(TokenKind::Eq)?;
                let value = self.expr(0)?;
                self.expect(TokenKind::In)?;
                let body = self.expr(0)?;
                let span = tok.span.to(body.span);
                Ok(Expr::new(ExprKind::Let { name: name.clone(), value: Box::new(value), body: Box::new(body) }, span))
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> Result<Expr> {
        let mut expr = self.atom()?;
        while self.peek().kind == TokenKind::LBracket {
            self.advance();
            let index = self.expr(0)?;
            let close = self.expect(TokenKind::RBracket)?;
            let span = expr.span.to(close.span);
            expr = Expr::new(ExprKind::Index { target: Box::new(expr), index: Box::new(index) }, span);
        }
        Ok(expr)
    }

    fn atom(&mut self) -> Result<Expr> {
        let tok = self.advance();
        let kind = match &tok.kind {
            TokenKind::Int(n) => ExprKind::Int(*n),
            TokenKind::Float(x) => ExprKind::Float(*x),
            TokenKind::Str(s) => ExprKind::Str(s.clone()),
            TokenKind::True => ExprKind::Bool(true),
            TokenKind::False => ExprKind::Bool(false),
            TokenKind::Ident(name) => {
                if self.eat(&TokenKind::LParen) {
                    let (args, end) = self.list(TokenKind::RParen)?;
                    return Ok(Expr::new(
                        ExprKind::Call { func: name.clone(), func_span: tok.span, args },
                        tok.span.to(end),
                    ));
                }
                ExprKind::Var(name.clone())
            }
            TokenKind::LParen => {
                let inner = self.expr(0)?;
                let close = self.expect(TokenKind::RParen)?;
                return Ok(Expr::new(inner.kind, tok.span.to(close.span)));
            }
            TokenKind::LBracket => {
                let (items, end) = self.list(TokenKind::RBracket)?;
                return Ok(Expr::new(ExprKind::List(items), tok.span.to(end)));
            }
            other => return Err(Error::syntax(format!("expected an expression, found {other}"), tok.span)),
        };
        Ok(Expr::new(kind, tok.span))
    }

    /// Comma-separated expressions up to `close`, which is consumed. A
    /// trailing comma is allowed. Returns the items and the closing span.
    fn list(&mut self, close: TokenKind) -> Result<(Vec<Expr>, Span)> {
        let mut items = Vec::new();
        loop {
            if self.peek().kind == close {
                break;
            }
            items.push(self.expr(0)?);
            if !self.eat(&TokenKind::Comma) {
                break;
            }
        }
        let end = self.expect(close)?.span;
        Ok((items, end))
    }
}
