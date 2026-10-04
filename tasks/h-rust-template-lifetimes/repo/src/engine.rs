use std::collections::HashMap;

use crate::error::Error;
use crate::render::Renderer;
use crate::template::Template;
use crate::value::Value;

/// A set of named templates that can include each other.
#[derive(Default)]
pub struct Engine {
    templates: HashMap<String, Template>,
}

impl Engine {
    /// Maximum include nesting; deeper nesting is reported as
    /// `Error::IncludeDepth` (this is how include cycles surface).
    pub const MAX_DEPTH: usize = 16;

    pub fn new() -> Engine {
        Engine::default()
    }

    /// Parses and registers a template, replacing any template with the same
    /// name. On a syntax error nothing is registered.
    pub fn add_template(&mut self, name: &str, source: impl Into<String>) -> Result<(), Error> {
        let template = Template::new(source)?;
        self.templates.insert(name.to_string(), template);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<&Template> {
        self.templates.get(name)
    }

    pub fn len(&self) -> usize {
        self.templates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.templates.is_empty()
    }

    pub fn render(&self, name: &str, ctx: &Value) -> Result<String, Error> {
        let mut out = String::new();
        self.render_into(name, ctx, 0, &mut out)?;
        Ok(out)
    }

    pub(crate) fn render_into(
        &self,
        name: &str,
        ctx: &Value,
        depth: usize,
        out: &mut String,
    ) -> Result<(), Error> {
        if depth > Self::MAX_DEPTH {
            return Err(Error::IncludeDepth(name.to_string()));
        }
        let template = self
            .get(name)
            .ok_or_else(|| Error::UnknownTemplate(name.to_string()))?;
        template.render_with(
            &Renderer {
                engine: Some(self),
                depth,
            },
            ctx,
            out,
        )
    }
}
