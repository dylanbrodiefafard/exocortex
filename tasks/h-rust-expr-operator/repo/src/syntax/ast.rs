//! The syntax tree.

use crate::span::Span;
use crate::syntax::ops::{BinOp, UnOp};

#[derive(Clone, Debug, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    /// The whole expression.
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ExprKind {
    Int(i64),
    Float(f64),
    Str(String),
    Bool(bool),
    List(Vec<Expr>),
    Var(String),
    Unary {
        op: UnOp,
        /// The operator token; errors about the operation point here.
        op_span: Span,
        operand: Box<Expr>,
    },
    Binary {
        op: BinOp,
        /// The operator token; errors about the operation point here.
        op_span: Span,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    If {
        cond: Box<Expr>,
        then_branch: Box<Expr>,
        else_branch: Box<Expr>,
    },
    Let {
        name: String,
        value: Box<Expr>,
        body: Box<Expr>,
    },
    Call {
        func: String,
        func_span: Span,
        args: Vec<Expr>,
    },
    Index {
        target: Box<Expr>,
        index: Box<Expr>,
    },
}

impl Expr {
    pub fn new(kind: ExprKind, span: Span) -> Expr {
        Expr { kind, span }
    }
}
