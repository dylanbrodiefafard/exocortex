use rill::syntax::lexer::tokenize;
use rill::syntax::token::TokenKind::{self, *};

fn kinds(src: &str) -> Vec<TokenKind> {
    tokenize(src).unwrap().into_iter().map(|t| t.kind).collect()
}

fn lex_error(src: &str) -> String {
    tokenize(src).unwrap_err().render(src)
}

#[test]
fn numbers_and_names() {
    assert_eq!(kinds("12 3.25 x_1 let"), vec![Int(12), Float(3.25), Ident("x_1".into()), Let, Eof]);
}

#[test]
fn dot_without_digits_is_not_a_float() {
    assert!(tokenize("1.").is_err());
}

#[test]
fn punctuation_longest_match() {
    assert_eq!(
        kinds("+ ++ - * / % == != < <= > >= = ( ) [ ] ,"),
        vec![Plus, PlusPlus, Minus, Star, Slash, Percent, EqEq, BangEq, Lt, Le, Gt, Ge, Eq, LParen, RParen, LBracket, RBracket, Comma, Eof]
    );
    assert_eq!(kinds("a+++b"), vec![Ident("a".into()), PlusPlus, Plus, Ident("b".into()), Eof]);
    assert_eq!(kinds("1--2"), vec![Int(1), Minus, Minus, Int(2), Eof]);
}

#[test]
fn strings_and_escapes() {
    assert_eq!(kinds(r#""a\n\"b\"\\""#), vec![Str("a\n\"b\"\\".into()), Eof]);
}

#[test]
fn comments() {
    assert_eq!(kinds("1 # one\n+ 2 # two"), vec![Int(1), Plus, Int(2), Eof]);
}

#[test]
fn spans() {
    let toks = tokenize("ab <= 1").unwrap();
    let spans: Vec<_> = toks.iter().map(|t| (t.span.start, t.span.end)).collect();
    assert_eq!(spans, vec![(0, 2), (3, 5), (6, 7), (7, 7)]);
}

#[test]
fn errors() {
    assert_eq!(lex_error("1 + $"), "syntax error at 1:5: unexpected character `$`");
    assert_eq!(lex_error("\"abc"), "syntax error at 1:1: unterminated string");
    assert_eq!(lex_error(r#"  "a\q""#), "syntax error at 1:5: unknown escape `\\q`");
    assert_eq!(lex_error("x\n 99999999999999999999"), "syntax error at 2:2: integer literal is too large");
    assert_eq!(lex_error("1 ! 2"), "syntax error at 1:3: unexpected character `!`");
}
