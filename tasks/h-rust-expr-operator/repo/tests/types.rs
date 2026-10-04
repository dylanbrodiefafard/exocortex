mod common;

use common::ty;

#[test]
fn literals_and_lists() {
    assert_eq!(ty("1"), "Int");
    assert_eq!(ty("1.5"), "Float");
    assert_eq!(ty("[\"a\"]"), "List[Str]");
    assert_eq!(ty("[]"), "List[?]");
    assert_eq!(ty("[[], [1]]"), "List[List[Int]]");
    assert_eq!(ty("[1, \"a\"]"), "type error at 1:5: list items must have the same type, found Int and Str");
}

#[test]
fn arithmetic() {
    assert_eq!(ty("1 + 2"), "Int");
    assert_eq!(ty("1 * 2.0"), "Float");
    assert_eq!(ty("-1.5"), "Float");
    assert_eq!(ty("1 + \"a\""), "type error at 1:3: operator `+` expects numbers, found Int and Str");
    assert_eq!(ty("true % 2"), "type error at 1:6: operator `%` expects numbers, found Bool and Int");
    assert_eq!(ty("-\"a\""), "type error at 1:1: operator `-` expects a number, found Str");
}

#[test]
fn concat() {
    assert_eq!(ty("\"a\" ++ \"b\""), "Str");
    assert_eq!(ty("[1] ++ []"), "List[Int]");
    assert_eq!(ty("[1] ++ [2.0]"), "type error at 1:5: operator `++` expects two lists of the same type, found List[Int] and List[Float]");
    assert_eq!(ty("1 ++ 2"), "type error at 1:3: operator `++` expects two strings or two lists, found Int and Int");
}

#[test]
fn comparison_and_logic() {
    assert_eq!(ty("1 < 2.5"), "Bool");
    assert_eq!(ty("\"a\" <= \"b\""), "Bool");
    assert_eq!(ty("[1] == [2]"), "Bool");
    assert_eq!(ty("1 == \"1\""), "type error at 1:3: cannot compare Int with Str");
    assert_eq!(ty("true < false"), "type error at 1:6: operator `<` expects two numbers or two strings, found Bool and Bool");
    assert_eq!(ty("1 and true"), "type error at 1:3: operator `and` expects Bool operands, found Int and Bool");
    assert_eq!(ty("not 1"), "type error at 1:1: operator `not` expects Bool, found Int");
}

#[test]
fn if_let_and_variables() {
    assert_eq!(ty("let x = 1 in x + 1"), "Int");
    assert_eq!(ty("let x = 1 in let x = \"s\" in x"), "Str");
    assert_eq!(ty("y"), "type error at 1:1: unknown variable `y`");
    assert_eq!(ty("if 1 then 2 else 3"), "type error at 1:4: condition must be Bool, found Int");
    assert_eq!(ty("if true then 1 else 2.0"), "type error at 1:1: `if` branches have different types: Int and Float");
}

#[test]
fn calls_and_indexing() {
    assert_eq!(ty("len(\"abc\")"), "Int");
    assert_eq!(ty("pow(2, 0.5)"), "Float");
    assert_eq!(ty("[1, 2][0]"), "Int");
    assert_eq!(ty("\"abc\"[1]"), "Str");
    assert_eq!(ty("nope(1)"), "type error at 1:1: unknown function `nope`");
    assert_eq!(ty("len(1, 2)"), "type error at 1:1: `len` takes 1 argument, found 2");
    assert_eq!(ty("max(1)"), "type error at 1:1: `max` takes 2 arguments, found 1");
    assert_eq!(ty("upper(1)"), "type error at 1:1: `upper`: expected Str, found Int");
    assert_eq!(ty("pow(\"a\", 1)"), "type error at 1:1: `pow`: expected numbers, found Str and Int");
    assert_eq!(ty("[1][\"a\"]"), "type error at 1:5: index must be Int, found Str");
    assert_eq!(ty("5[0]"), "type error at 1:1: cannot index a value of type Int");
}
