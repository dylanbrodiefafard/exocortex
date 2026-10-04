use forth::{Error, Forth};

fn run(input: &str) -> (Result<(), Error>, Vec<i64>) {
    let mut f = Forth::new();
    let result = f.eval(input);
    (result, f.stack().to_vec())
}

fn ok(input: &str) -> Vec<i64> {
    let (result, stack) = run(input);
    assert_eq!(result, Ok(()), "eval({input:?}) failed");
    stack
}

#[test]
fn starts_empty() {
    assert!(Forth::new().stack().is_empty());
}

#[test]
fn pushes_numbers() {
    assert_eq!(ok("1 2 3 -4"), vec![1, 2, 3, -4]);
}

#[test]
fn any_whitespace_separates() {
    assert_eq!(ok("  1\t2\n\n3  "), vec![1, 2, 3]);
}

#[test]
fn addition_and_subtraction() {
    assert_eq!(ok("1 2 +"), vec![3]);
    assert_eq!(ok("3 10 -"), vec![-7]);
}

#[test]
fn multiplication_and_division() {
    assert_eq!(ok("6 7 *"), vec![42]);
    assert_eq!(ok("12 4 /"), vec![3]);
    assert_eq!(ok("7 2 /"), vec![3]);
}

#[test]
fn division_by_zero() {
    assert_eq!(run("4 0 /").0, Err(Error::DivisionByZero));
}

#[test]
fn stack_words() {
    assert_eq!(ok("1 dup"), vec![1, 1]);
    assert_eq!(ok("1 2 drop"), vec![1]);
    assert_eq!(ok("1 2 swap"), vec![2, 1]);
    assert_eq!(ok("1 2 over"), vec![1, 2, 1]);
}

#[test]
fn underflow() {
    assert_eq!(run("+").0, Err(Error::StackUnderflow));
    assert_eq!(run("1 swap").0, Err(Error::StackUnderflow));
    assert_eq!(run("drop").0, Err(Error::StackUnderflow));
}

#[test]
fn state_persists_between_calls() {
    let mut f = Forth::new();
    f.eval("1 2").unwrap();
    f.eval("+ 4").unwrap();
    assert_eq!(f.stack(), [3, 4]);
}

#[test]
fn simple_definition() {
    assert_eq!(ok(": square dup * ; 5 square"), vec![25]);
}

#[test]
fn division_truncates_toward_zero() {
    assert_eq!(ok("-7 2 /"), vec![-3]);
    assert_eq!(ok("7 -2 /"), vec![-3]);
    assert_eq!(ok("-8 -2 /"), vec![4]);
}

#[test]
fn arithmetic_wraps() {
    assert_eq!(ok("9223372036854775807 1 +"), vec![i64::MIN]);
    assert_eq!(ok("-9223372036854775807 2 -"), vec![i64::MAX]);
    assert_eq!(ok("4611686018427387904 2 *"), vec![i64::MIN]);
    assert_eq!(ok("-9223372036854775807 1 - -1 /"), vec![i64::MIN]);
}

#[test]
fn minus_alone_is_a_word() {
    assert_eq!(ok("5 3 -"), vec![2]);
    assert_eq!(run("-").0, Err(Error::StackUnderflow));
    assert_eq!(run("--5").0, Err(Error::UnknownWord));
}

#[test]
fn builtins_are_case_insensitive() {
    assert_eq!(ok("1 DUP Dup dUP"), vec![1, 1, 1, 1]);
    assert_eq!(ok("1 2 SWAP 3 Over DROP"), vec![2, 1, 3]);
}

#[test]
fn unknown_word() {
    assert_eq!(run("1 frobnicate").0, Err(Error::UnknownWord));
    assert_eq!(run("12abc").0, Err(Error::UnknownWord));
}

#[test]
fn failing_builtin_leaves_stack_untouched() {
    assert_eq!(run("1 0 /"), (Err(Error::DivisionByZero), vec![1, 0]));
    assert_eq!(run("7 +"), (Err(Error::StackUnderflow), vec![7]));
    assert_eq!(run("7 over"), (Err(Error::StackUnderflow), vec![7]));
}

#[test]
fn work_before_an_error_is_kept() {
    assert_eq!(run("1 2 + drop drop 5"), (Err(Error::StackUnderflow), vec![]));
    assert_eq!(run("1 2 nope 3"), (Err(Error::UnknownWord), vec![1, 2]));
}

#[test]
fn errors_stop_evaluation() {
    let mut f = Forth::new();
    assert_eq!(f.eval("1 0 / 99"), Err(Error::DivisionByZero));
    assert_eq!(f.stack(), [1, 0]);
    f.eval("drop 2 *").unwrap();
    assert_eq!(f.stack(), [2]);
}
