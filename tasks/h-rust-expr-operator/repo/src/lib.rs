//! rill: a small, statically typed expression language.
//!
//! A program is a single expression. It is lexed ([`syntax::lexer`]),
//! parsed ([`syntax::parser`]), type checked ([`types::check`]) and then
//! evaluated ([`eval::interp`]). [`syntax::printer`] turns a syntax tree back
//! into canonical source text. The language is described in
//! `docs/language.md`.

pub mod builtins;
pub mod error;
pub mod eval;
pub mod span;
pub mod syntax;
pub mod types;

pub use error::{Error, ErrorKind, Result};
pub use eval::value::Value;
pub use syntax::ast::Expr;
pub use types::ty::Type;

/// Parses `src` into a syntax tree.
pub fn parse(src: &str) -> Result<Expr> {
    let tokens = syntax::lexer::tokenize(src)?;
    syntax::parser::parse(&tokens)
}

/// Parses and type checks `src`, returning the type of the program.
pub fn check(src: &str) -> Result<Type> {
    let expr = parse(src)?;
    types::check::check_program(&expr)
}

/// Parses, type checks and evaluates `src`.
pub fn eval(src: &str) -> Result<Value> {
    let expr = parse(src)?;
    types::check::check_program(&expr)?;
    eval::interp::eval_program(&expr)
}

/// Parses `src` and prints it back in canonical form.
pub fn format(src: &str) -> Result<String> {
    Ok(syntax::printer::print(&parse(src)?))
}

/// The operator table shown by `rill ops`.
pub fn describe_operators() -> String {
    syntax::ops::describe()
}
