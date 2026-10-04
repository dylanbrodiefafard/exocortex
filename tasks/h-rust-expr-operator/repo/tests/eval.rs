mod common;

use common::run;

#[test]
fn arithmetic() {
    assert_eq!(run("1 + 2 * 3"), "7");
    assert_eq!(run("7 / 2"), "3");
    assert_eq!(run("-7 / 2"), "-3");
    assert_eq!(run("-7 % 3"), "-1");
    assert_eq!(run("7 / 2.0"), "3.5");
    assert_eq!(run("2.0 * 2"), "4.0");
    assert_eq!(run("0.1 + 0.2"), "0.30000000000000004");
    assert_eq!(run("- -3"), "3");
}

#[test]
fn arithmetic_errors_point_at_the_operator() {
    assert_eq!(run("9223372036854775807 + 1"), "runtime error at 1:21: integer overflow");
    assert_eq!(run("1 / 0"), "runtime error at 1:3: division by zero");
    assert_eq!(run("1 % 0.0"), "runtime error at 1:3: division by zero");
    assert_eq!(run("let big = 9223372036854775807 in -big - 2"), "runtime error at 1:39: integer overflow");
    assert_eq!(run("1.0e0"), "syntax error at 1:4: expected end of input, found identifier `e0`");
}

#[test]
fn float_results_must_be_finite() {
    let big = "let x = 100000000000000000000.0 in x * x * x * x * x * x * x * x * x * x * x * x * x * x * x * x";
    assert_eq!(run(big), "runtime error at 1:94: result is not a finite number");
}

#[test]
fn strings_and_lists() {
    assert_eq!(run("\"ab\" ++ \"cd\""), "\"abcd\"");
    assert_eq!(run("[1] ++ [2, 3]"), "[1, 2, 3]");
    assert_eq!(run("[1, 2, 3][-1]"), "3");
    assert_eq!(run("\"héllo\"[1]"), "\"é\"");
    assert_eq!(run("[1, 2][2]"), "runtime error at 1:8: index 2 is out of range for length 2");
    assert_eq!(run("\"tab\\t\""), "\"tab\\t\"");
}

#[test]
fn comparison() {
    assert_eq!(run("1 == 1.0"), "true");
    assert_eq!(run("[1, 2] == [1, 2.0] or false"), "type error at 1:15: list items must have the same type, found Int and Float");
    assert_eq!(run("\"a\" < \"b\""), "true");
    assert_eq!(run("2 >= 2.5"), "false");
}

#[test]
fn short_circuit() {
    assert_eq!(run("false and 1 / 0 == 1"), "false");
    assert_eq!(run("true or 1 / 0 == 1"), "true");
    assert_eq!(run("if true then 1 else 1 / 0"), "1");
}

#[test]
fn let_scoping() {
    assert_eq!(run("let x = 1 in (let x = 2 in x) + x"), "3");
}
