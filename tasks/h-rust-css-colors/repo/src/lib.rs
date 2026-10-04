//! CSS color parsing, conversion and WCAG contrast checks.
//!
//! ```
//! let c = chroma::parse("rebeccapurple").unwrap();
//! assert_eq!(c.to_hex(), "#663399");
//! ```
//!
//! See README.md for the accepted syntax and the conversion rules.

pub mod color;
pub mod contrast;
pub mod legacy;
pub mod named;
pub mod parse;

pub use color::{Hsla, Rgba};
pub use parse::{parse, ParseError};
