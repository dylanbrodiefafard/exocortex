use std::fmt::Write;

use crate::engine::Engine;
use crate::error::Error;
use crate::parser::Node;
use crate::value::Value;

/// Name/value bindings introduced by `for` loops, innermost last.
struct Scope<'v> {
    root: &'v Value,
    frames: Vec<(&'v str, &'v Value)>,
}

impl<'v> Scope<'v> {
    fn lookup(&self, path: &str) -> Option<&'v Value> {
        let mut segs = path.split('.');
        let first = segs.next()?;
        let mut cur = match self.frames.iter().rev().find(|(name, _)| *name == first) {
            Some((_, v)) => *v,
            None => self.root.get(first)?,
        };
        for seg in segs {
            cur = cur.get(seg)?;
        }
        Some(cur)
    }
}

pub(crate) struct Renderer<'e> {
    pub engine: Option<&'e Engine>,
    pub depth: usize,
}

impl Renderer<'_> {
    pub fn render(&self, nodes: &[Node], ctx: &Value, out: &mut String) -> Result<(), Error> {
        let mut scope = Scope {
            root: ctx,
            frames: Vec::new(),
        };
        self.nodes(nodes, &mut scope, out)
    }

    fn nodes<'v>(
        &self,
        nodes: &'v [Node],
        scope: &mut Scope<'v>,
        out: &mut String,
    ) -> Result<(), Error> {
        for node in nodes {
            match node {
                Node::Text(text) => out.push_str(text),
                Node::Var {
                    path,
                    filters,
                    line,
                } => {
                    let value = scope.lookup(path).ok_or_else(|| Error::MissingValue {
                        line: *line,
                        path: path.to_string(),
                    })?;
                    let mut value = value.clone();
                    for f in filters {
                        value = apply_filter(f, value, *line)?;
                    }
                    write_value(&value, *line, out)?;
                }
                Node::If {
                    path,
                    negate,
                    then,
                    otherwise,
                    line,
                } => {
                    let value = scope.lookup(path).ok_or_else(|| Error::MissingValue {
                        line: *line,
                        path: path.to_string(),
                    })?;
                    if value.truthy() != *negate {
                        self.nodes(then, scope, out)?;
                    } else {
                        self.nodes(otherwise, scope, out)?;
                    }
                }
                Node::For {
                    var,
                    path,
                    body,
                    line,
                } => {
                    let value = scope.lookup(path).ok_or_else(|| Error::MissingValue {
                        line: *line,
                        path: path.to_string(),
                    })?;
                    let Value::List(items) = value else {
                        return Err(Error::Type {
                            line: *line,
                            msg: format!("cannot loop over {} `{path}`", value.type_name()),
                        });
                    };
                    for item in items {
                        scope.frames.push((var, item));
                        let res = self.nodes(body, scope, out);
                        scope.frames.pop();
                        res?;
                    }
                }
                Node::Include { name, .. } => {
                    let engine = self
                        .engine
                        .ok_or_else(|| Error::UnknownTemplate(name.to_string()))?;
                    engine.render_into(name, scope.root, self.depth + 1, out)?;
                }
            }
        }
        Ok(())
    }
}

fn apply_filter(name: &str, value: Value, line: usize) -> Result<Value, Error> {
    let type_err = |v: &Value| Error::Type {
        line,
        msg: format!("filter `{name}` does not apply to {}", v.type_name()),
    };
    match name {
        "upper" | "lower" | "trim" => match value {
            Value::Str(s) => Ok(Value::Str(match name {
                "upper" => s.to_uppercase(),
                "lower" => s.to_lowercase(),
                _ => s.trim().to_string(),
            })),
            other => Err(type_err(&other)),
        },
        "len" => match &value {
            Value::Str(s) => Ok(Value::Num(s.chars().count() as f64)),
            Value::List(l) => Ok(Value::Num(l.len() as f64)),
            Value::Map(m) => Ok(Value::Num(m.len() as f64)),
            other => Err(type_err(other)),
        },
        _ => Err(Error::UnknownFilter {
            line,
            name: name.to_string(),
        }),
    }
}

fn write_value(value: &Value, line: usize, out: &mut String) -> Result<(), Error> {
    match value {
        Value::Null => {}
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) if n.fract() == 0.0 && n.abs() < 1e15 => {
            let _ = write!(out, "{}", *n as i64);
        }
        Value::Num(n) => {
            let _ = write!(out, "{n}");
        }
        Value::Str(s) => out.push_str(s),
        other => {
            return Err(Error::Type {
                line,
                msg: format!("cannot print a {}", other.type_name()),
            });
        }
    }
    Ok(())
}
