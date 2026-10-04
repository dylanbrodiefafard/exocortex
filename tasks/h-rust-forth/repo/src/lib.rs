//! A small interpreter for a subset of Forth.
//!
//! # Language
//!
//! Input is a sequence of tokens separated by any whitespace (spaces, tabs,
//! newlines). The interpreter keeps a stack of `Value`s (64-bit signed
//! integers) that persists across calls to [`Forth::eval`], as do user
//! definitions.
//!
//! * **Numbers.** A token made of an optional leading `-` followed by one or
//!   more ASCII digits is a number and is pushed onto the stack.
//! * **Words.** Every other token is a word. Words are case-insensitive:
//!   `DUP`, `dup` and `Dup` are the same word.
//!
//! ## Built-in words
//!
//! | Word | Stack effect | Notes |
//! |------|--------------|-------|
//! | `+`  | `a b -- a+b` | |
//! | `-`  | `a b -- a-b` | |
//! | `*`  | `a b -- a*b` | |
//! | `/`  | `a b -- a/b` | truncates toward zero; `b == 0` is `DivisionByZero` |
//! | `dup`  | `a -- a a` | |
//! | `drop` | `a --` | |
//! | `swap` | `a b -- b a` | |
//! | `over` | `a b -- a b a` | |
//!
//! Arithmetic wraps on overflow (two's complement), it never panics.
//! A built-in that does not find enough values on the stack fails with
//! `StackUnderflow`. A failing built-in leaves the stack exactly as it was
//! before that word ran.
//!
//! ## User-defined words
//!
//! `: name body... ;` defines (or redefines) the word `name`.
//!
//! * `name` may be any word, including a built-in (`: swap dup ;` is legal
//!   and replaces `swap` from then on). It must not be a number: `: 1 2 ;`
//!   fails with `InvalidWord`.
//! * The body is bound when the definition is made: every word in it refers
//!   to the meaning that word has *at that moment*. Redefining a word later
//!   does not change words that were defined earlier using it. In particular
//!   `: x x 1 + ;` refers to the previous `x`; there is no recursion.
//! * A word in the body that has no meaning at definition time makes the
//!   definition fail with `UnknownWord`; the name keeps its previous meaning.
//! * The body may be empty. It may not contain `:` or `;` other than the
//!   closing `;`.
//! * A definition must be completed within one `eval` call. A `:` without a
//!   name, a definition missing its closing `;`, and a `;` outside a
//!   definition all fail with `InvalidWord`.
//!
//! Running a user-defined word runs its body. Running an unknown word fails
//! with `UnknownWord`.
//!
//! ## Errors
//!
//! `eval` stops at the first error and returns it. Everything that happened
//! before the error (values pushed or consumed, definitions completed,
//! including earlier steps of a user-defined word that failed part-way) is
//! kept.

/// The type of every stack entry.
pub type Value = i64;

/// Why evaluation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// A word needed more values than the stack held.
    StackUnderflow,
    /// `/` with a zero divisor.
    DivisionByZero,
    /// A word with no built-in or user definition.
    UnknownWord,
    /// A malformed definition (see the module docs).
    InvalidWord,
}

/// An interpreter instance: a stack plus the current dictionary.
pub struct Forth {}

impl Forth {
    /// A fresh interpreter: empty stack, only the built-in words.
    pub fn new() -> Forth {
        todo!()
    }

    /// The stack, bottom first.
    pub fn stack(&self) -> &[Value] {
        todo!()
    }

    /// Evaluate `input`. See the module docs for the language.
    pub fn eval(&mut self, input: &str) -> Result<(), Error> {
        todo!("evaluate {input:?}")
    }
}

impl Default for Forth {
    fn default() -> Self {
        Forth::new()
    }
}
