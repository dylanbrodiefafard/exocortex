use crate::error::Error;
use crate::parser::{parse, Node};
use crate::render::Renderer;
use crate::value::Value;

/// A parsed template. It owns its source text.
pub struct Template {
    source: String,
    nodes: Vec<Node>,
}

impl Template {
    /// Parses `source`. Syntax errors are reported here, not at render time.
    pub fn new(source: impl Into<String>) -> Result<Template, Error> {
        let source = source.into();
        let nodes = parse(&source)?;
        Ok(Template { source, nodes })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    /// Renders with `ctx`. `{% include %}` needs an [`crate::Engine`]; here it
    /// fails with `Error::UnknownTemplate`.
    pub fn render(&self, ctx: &Value) -> Result<String, Error> {
        let mut out = String::new();
        Renderer {
            engine: None,
            depth: 0,
        }
        .render(&self.nodes, ctx, &mut out)?;
        Ok(out)
    }

    pub(crate) fn render_with(
        &self,
        renderer: &Renderer,
        ctx: &Value,
        out: &mut String,
    ) -> Result<(), Error> {
        renderer.render(&self.nodes, ctx, out)
    }
}
