//! Operators: the single table of binary operators with their spelling,
//! precedence and associativity. The parser, the printer and `rill ops` all
//! read it.

use std::fmt;

use crate::syntax::token::TokenKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinOp {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Concat,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnOp {
    Neg,
    Not,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Assoc {
    Left,
    Right,
    /// The operator cannot be chained: `a < b < c` is a syntax error.
    None,
}

impl fmt::Display for Assoc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Assoc::Left => "left",
            Assoc::Right => "right",
            Assoc::None => "none",
        })
    }
}

#[derive(Debug)]
pub struct OpInfo {
    pub op: BinOp,
    pub token: TokenKind,
    pub symbol: &'static str,
    /// Higher binds tighter.
    pub prec: u8,
    pub assoc: Assoc,
    pub description: &'static str,
}

/// Precedence of the prefix operators `-` and `not`.
pub const UNARY_PREC: u8 = 70;
/// Precedence of atoms, calls and indexing; nothing binds tighter.
pub const POSTFIX_PREC: u8 = 100;

/// Every binary operator.
pub static BINARY_OPS: &[OpInfo] = &[
    OpInfo { op: BinOp::Or, token: TokenKind::Or, symbol: "or", prec: 10, assoc: Assoc::Left, description: "logical or (short-circuit)" },
    OpInfo { op: BinOp::And, token: TokenKind::And, symbol: "and", prec: 20, assoc: Assoc::Left, description: "logical and (short-circuit)" },
    OpInfo { op: BinOp::Eq, token: TokenKind::EqEq, symbol: "==", prec: 30, assoc: Assoc::None, description: "equal" },
    OpInfo { op: BinOp::Ne, token: TokenKind::BangEq, symbol: "!=", prec: 30, assoc: Assoc::None, description: "not equal" },
    OpInfo { op: BinOp::Lt, token: TokenKind::Lt, symbol: "<", prec: 30, assoc: Assoc::None, description: "less than" },
    OpInfo { op: BinOp::Le, token: TokenKind::Le, symbol: "<=", prec: 30, assoc: Assoc::None, description: "less than or equal" },
    OpInfo { op: BinOp::Gt, token: TokenKind::Gt, symbol: ">", prec: 30, assoc: Assoc::None, description: "greater than" },
    OpInfo { op: BinOp::Ge, token: TokenKind::Ge, symbol: ">=", prec: 30, assoc: Assoc::None, description: "greater than or equal" },
    OpInfo { op: BinOp::Concat, token: TokenKind::PlusPlus, symbol: "++", prec: 40, assoc: Assoc::Right, description: "concatenation of strings or lists" },
    OpInfo { op: BinOp::Add, token: TokenKind::Plus, symbol: "+", prec: 50, assoc: Assoc::Left, description: "addition" },
    OpInfo { op: BinOp::Sub, token: TokenKind::Minus, symbol: "-", prec: 50, assoc: Assoc::Left, description: "subtraction" },
    OpInfo { op: BinOp::Mul, token: TokenKind::Star, symbol: "*", prec: 60, assoc: Assoc::Left, description: "multiplication" },
    OpInfo { op: BinOp::Div, token: TokenKind::Slash, symbol: "/", prec: 60, assoc: Assoc::Left, description: "division (integers truncate toward zero)" },
    OpInfo { op: BinOp::Mod, token: TokenKind::Percent, symbol: "%", prec: 60, assoc: Assoc::Left, description: "remainder (sign of the left operand)" },
];

/// The table entry for `op`.
pub fn info(op: BinOp) -> &'static OpInfo {
    BINARY_OPS.iter().find(|i| i.op == op).expect("every BinOp is in BINARY_OPS")
}

/// The binary operator a token stands for, if any.
pub fn binary_op(token: &TokenKind) -> Option<&'static OpInfo> {
    BINARY_OPS.iter().find(|i| &i.token == token)
}

impl BinOp {
    pub fn symbol(self) -> &'static str {
        info(self).symbol
    }
}

impl UnOp {
    pub fn symbol(self) -> &'static str {
        match self {
            UnOp::Neg => "-",
            UnOp::Not => "not",
        }
    }
}

/// One line per operator, tightest binding first (table order within a
/// level), prefix operators included:
/// `<symbol padded to 4> <prec padded to 3>  <assoc padded to 6> <description>`.
pub fn describe() -> String {
    let mut rows: Vec<(&str, u8, String, &str)> = BINARY_OPS
        .iter()
        .map(|i| (i.symbol, i.prec, i.assoc.to_string(), i.description))
        .collect();
    rows.push(("-", UNARY_PREC, "prefix".to_string(), "negation"));
    rows.push(("not", UNARY_PREC, "prefix".to_string(), "logical not"));
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    rows.iter()
        .map(|(symbol, prec, assoc, description)| format!("{symbol:<4} {prec:>3}  {assoc:<6} {description}\n"))
        .collect()
}
