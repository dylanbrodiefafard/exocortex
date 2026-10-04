use crate::error::Error;
use crate::lexer::{tokenize, Spanned, Token};

#[derive(Debug, Clone, PartialEq)]
pub enum Node<'a> {
    Text(&'a str),
    Var {
        path: &'a str,
        filters: Vec<&'a str>,
        line: usize,
    },
    If {
        path: &'a str,
        negate: bool,
        then: Vec<Node<'a>>,
        otherwise: Vec<Node<'a>>,
        line: usize,
    },
    For {
        var: &'a str,
        path: &'a str,
        body: Vec<Node<'a>>,
        line: usize,
    },
    Include {
        name: &'a str,
        line: usize,
    },
}

/// Parses a template into nodes that borrow from `src`.
pub fn parse(src: &str) -> Result<Vec<Node<'_>>, Error> {
    let tokens = tokenize(src)?;
    let mut pos = 0;
    let (nodes, end) = parse_block(&tokens, &mut pos)?;
    if let Some((tag, line)) = end {
        return Err(Error::Syntax {
            line,
            msg: format!("unexpected `{{% {tag} %}}`"),
        });
    }
    Ok(nodes)
}

/// Parses nodes until an `else`, `endif` or `endfor` tag (returned with its
/// line) or the end of input (`None`).
fn parse_block<'a>(
    tokens: &[Spanned<'a>],
    pos: &mut usize,
) -> Result<(Vec<Node<'a>>, Option<(&'a str, usize)>), Error> {
    let mut nodes = Vec::new();
    while let Some(tok) = tokens.get(*pos) {
        *pos += 1;
        let line = tok.line;
        match tok.token {
            Token::Text(text) => nodes.push(Node::Text(text)),
            Token::Expr(expr) => nodes.push(parse_var(expr, line)?),
            Token::Tag(tag) => {
                let mut words = tag.split_whitespace();
                match words.next() {
                    Some(end @ ("else" | "endif" | "endfor")) => {
                        if words.next().is_some() {
                            return Err(Error::Syntax {
                                line,
                                msg: format!("`{end}` takes no arguments"),
                            });
                        }
                        return Ok((nodes, Some((end, line))));
                    }
                    Some("if") => nodes.push(parse_if(tokens, pos, &tag[2..], line)?),
                    Some("for") => nodes.push(parse_for(tokens, pos, &tag[3..], line)?),
                    Some("include") => nodes.push(parse_include(&tag[7..], line)?),
                    _ => {
                        return Err(Error::Syntax {
                            line,
                            msg: format!("unknown tag `{tag}`"),
                        })
                    }
                }
            }
        }
    }
    Ok((nodes, None))
}

fn parse_var(expr: &str, line: usize) -> Result<Node<'_>, Error> {
    let mut parts = expr.split('|').map(str::trim);
    let path = parts.next().unwrap_or("");
    check_path(path, line)?;
    let filters: Vec<&str> = parts.collect();
    if filters.iter().any(|f| f.is_empty()) {
        return Err(Error::Syntax {
            line,
            msg: "empty filter".to_string(),
        });
    }
    Ok(Node::Var {
        path,
        filters,
        line,
    })
}

fn parse_if<'a>(
    tokens: &[Spanned<'a>],
    pos: &mut usize,
    args: &'a str,
    line: usize,
) -> Result<Node<'a>, Error> {
    let args = args.trim();
    let (negate, path) = match args.strip_prefix("not ") {
        Some(rest) => (true, rest.trim()),
        None => (false, args),
    };
    check_path(path, line)?;
    let (then, end) = parse_block(tokens, pos)?;
    let otherwise = match end {
        Some(("endif", _)) => Vec::new(),
        Some(("else", _)) => match parse_block(tokens, pos)? {
            (nodes, Some(("endif", _))) => nodes,
            (_, other) => return Err(unclosed("if", "endif", line, other)),
        },
        other => return Err(unclosed("if", "endif", line, other)),
    };
    Ok(Node::If {
        path,
        negate,
        then,
        otherwise,
        line,
    })
}

fn parse_for<'a>(
    tokens: &[Spanned<'a>],
    pos: &mut usize,
    args: &'a str,
    line: usize,
) -> Result<Node<'a>, Error> {
    let words: Vec<&str> = args.split_whitespace().collect();
    let [var, "in", path] = words[..] else {
        return Err(Error::Syntax {
            line,
            msg: "expected `for NAME in PATH`".to_string(),
        });
    };
    if var.contains('.') {
        return Err(Error::Syntax {
            line,
            msg: format!("bad loop variable `{var}`"),
        });
    }
    check_path(var, line)?;
    check_path(path, line)?;
    match parse_block(tokens, pos)? {
        (body, Some(("endfor", _))) => Ok(Node::For {
            var,
            path,
            body,
            line,
        }),
        (_, other) => Err(unclosed("for", "endfor", line, other)),
    }
}

fn parse_include(args: &str, line: usize) -> Result<Node<'_>, Error> {
    let args = args.trim();
    match args.strip_prefix('"').and_then(|a| a.strip_suffix('"')) {
        Some(name) if !name.is_empty() && !name.contains('"') => Ok(Node::Include { name, line }),
        _ => Err(Error::Syntax {
            line,
            msg: "expected `include \"name\"`".to_string(),
        }),
    }
}

fn check_path(path: &str, line: usize) -> Result<(), Error> {
    let ok = !path.is_empty()
        && path.split('.').all(|seg| {
            !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
    if ok {
        Ok(())
    } else {
        Err(Error::Syntax {
            line,
            msg: format!("bad path `{path}`"),
        })
    }
}

fn unclosed(tag: &str, want: &str, line: usize, got: Option<(&str, usize)>) -> Error {
    match got {
        Some((end, end_line)) => Error::Syntax {
            line: end_line,
            msg: format!("expected `{want}`, found `{end}`"),
        },
        None => Error::Syntax {
            line,
            msg: format!("`{tag}` without `{want}`"),
        },
    }
}
