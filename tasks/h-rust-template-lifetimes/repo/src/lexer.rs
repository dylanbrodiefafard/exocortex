use crate::error::Error;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Token<'a> {
    /// Literal text between tags.
    Text(&'a str),
    /// The trimmed inside of `{{ … }}`.
    Expr(&'a str),
    /// The trimmed inside of `{% … %}`.
    Tag(&'a str),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spanned<'a> {
    pub token: Token<'a>,
    /// 1-based line on which the token starts.
    pub line: usize,
}

/// Splits a template into tokens. Comments are dropped.
pub fn tokenize(src: &str) -> Result<Vec<Spanned<'_>>, Error> {
    let mut out = Vec::new();
    let mut rest = src;
    let mut line = 1;
    while !rest.is_empty() {
        let Some(open) = find_open(rest) else {
            out.push(Spanned {
                token: Token::Text(rest),
                line,
            });
            break;
        };
        if open > 0 {
            let text = &rest[..open];
            out.push(Spanned {
                token: Token::Text(text),
                line,
            });
            line += count_lines(text);
        }
        let close_pat = match &rest[open + 1..open + 2] {
            "{" => "}}",
            "%" => "%}",
            _ => "#}",
        };
        let body_start = open + 2;
        let Some(close) = rest[body_start..].find(close_pat) else {
            return Err(Error::Syntax {
                line,
                msg: format!("missing `{close_pat}`"),
            });
        };
        let body = &rest[body_start..body_start + close];
        match &rest[open + 1..open + 2] {
            "{" => out.push(Spanned {
                token: Token::Expr(body.trim()),
                line,
            }),
            "%" => out.push(Spanned {
                token: Token::Tag(body.trim()),
                line,
            }),
            _ => {}
        }
        line += count_lines(body);
        rest = &rest[body_start + close + 2..];
    }
    Ok(out)
}

fn find_open(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    (0..bytes.len().saturating_sub(1))
        .find(|&i| bytes[i] == b'{' && matches!(bytes[i + 1], b'{' | b'%' | b'#'))
}

fn count_lines(s: &str) -> usize {
    s.bytes().filter(|&b| b == b'\n').count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_text_and_tags() {
        let toks = tokenize("Hi {{ name }}!\n{% if x %}y{# no #}{% endif %}").unwrap();
        let kinds: Vec<Token> = toks.iter().map(|t| t.token).collect();
        assert_eq!(
            kinds,
            vec![
                Token::Text("Hi "),
                Token::Expr("name"),
                Token::Text("!\n"),
                Token::Tag("if x"),
                Token::Text("y"),
                Token::Tag("endif"),
            ]
        );
        assert_eq!(toks[3].line, 2);
    }

    #[test]
    fn unclosed_tag() {
        assert!(matches!(
            tokenize("a\n{{ b"),
            Err(Error::Syntax { line: 2, .. })
        ));
    }
}
