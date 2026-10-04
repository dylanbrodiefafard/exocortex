//! A small text template engine.
//!
//! Syntax:
//!
//! - `{{ path }}` inserts a value. `path` is a dotted lookup such as
//!   `user.name`. Filters can follow: `{{ name | upper | trim }}`
//!   (`upper`, `lower`, `trim`, `len`).
//! - `{% if path %}…{% else %}…{% endif %}` and `{% if not path %}…{% endif %}`.
//! - `{% for item in path %}…{% endfor %}` iterates a list.
//! - `{% include "name" %}` renders another template registered with the
//!   same [`Engine`], with the same context.
//! - `{# comment #}` is dropped.
//!
//! Templates are parsed once, when they are created. Parsing is zero-copy:
//! the parsed form refers to the template's source text instead of copying
//! pieces of it into new strings.

mod engine;
mod error;
mod lexer;
mod parser;
mod render;
mod template;
mod value;

pub use engine::Engine;
pub use error::Error;
pub use template::Template;
pub use value::Value;
