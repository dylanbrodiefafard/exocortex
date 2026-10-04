//! A small INI-file parser.
//!
//! ```text
//! ; global settings
//! name = demo
//!
//! [server]
//! host = example.org
//! port = 8080
//! ```

mod document;
mod error;
mod parser;

pub use document::Ini;
pub use error::{ErrorKind, ParseError};
pub use parser::parse;
