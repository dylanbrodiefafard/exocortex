mod common;

use common::run;

#[test]
fn len_abs_min_max() {
    assert_eq!(run("len(\"héllo\")"), "5");
    assert_eq!(run("len([1, 2])"), "2");
    assert_eq!(run("abs(-3)"), "3");
    assert_eq!(run("abs(-2.5)"), "2.5");
    assert_eq!(run("min(3, 2)"), "2");
    assert_eq!(run("max(3, 2.5)"), "3.0");
}

#[test]
fn pow() {
    assert_eq!(run("pow(2, 10)"), "1024");
    assert_eq!(run("pow(-2, 3)"), "-8");
    assert_eq!(run("pow(2, 0)"), "1");
    assert_eq!(run("pow(4, 0.5)"), "2.0");
    assert_eq!(run("pow(2.0, -1)"), "0.5");
    assert_eq!(run("pow(-1, 9223372036854775807)"), "-1");
    assert_eq!(run("pow(2, 63)"), "runtime error at 1:1: integer overflow");
    assert_eq!(run("pow(2, -1)"), "runtime error at 1:1: negative exponent in integer power");
    assert_eq!(run("pow(-8.0, 0.5)"), "runtime error at 1:1: result is not a finite number");
    assert_eq!(run("1 + pow(10.0, 400)"), "runtime error at 1:5: result is not a finite number");
}

#[test]
fn sum_and_range() {
    assert_eq!(run("sum(range(1, 5))"), "10");
    assert_eq!(run("sum([0.5, 0.25])"), "0.75");
    assert_eq!(run("sum([])"), "0");
    assert_eq!(run("range(3, 1)"), "[]");
    assert_eq!(run("sum([9223372036854775807, 1])"), "runtime error at 1:1: integer overflow");
}

#[test]
fn conversions() {
    assert_eq!(run("str(1.5) ++ str(\"x\") ++ str([1])"), "\"1.5x[1]\"");
    assert_eq!(run("int(\" 42 \") + int(-2.9)"), "40");
    assert_eq!(run("float(\"2.5\") + float(1)"), "3.5");
    assert_eq!(run("int(\"x\")"), "runtime error at 1:1: cannot convert \"x\" to Int");
    assert_eq!(run("upper(\"abc\") ++ lower(\"DEF\")"), "\"ABCdef\"");
}
