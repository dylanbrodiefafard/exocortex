use std::sync::mpsc;
use std::thread;
use std::time::Duration;

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
fn definitions_persist_across_calls() {
    let mut f = Forth::new();
    f.eval(": double 2 * ;").unwrap();
    f.eval(": quad double double ;").unwrap();
    f.eval("3 quad").unwrap();
    assert_eq!(f.stack(), [12]);
}

#[test]
fn definition_spanning_lines() {
    assert_eq!(ok(": inc\n  1 +\n;\n41 inc"), vec![42]);
}

#[test]
fn user_words_are_case_insensitive() {
    assert_eq!(ok(": Twice DUP + ; 4 twice TWICE tWiCe"), vec![32]);
    assert_eq!(ok(": foo 1 ; : FOO 2 ; foo"), vec![2]);
}

#[test]
fn empty_body() {
    assert_eq!(ok("1 : nop ; nop nop"), vec![1]);
}

#[test]
fn redefinition_replaces() {
    assert_eq!(ok(": x 1 ; : x 2 ; x"), vec![2]);
}

#[test]
fn redefining_builtins() {
    assert_eq!(ok(": swap dup ; 1 swap"), vec![1, 1]);
    assert_eq!(ok(": + * ; 3 4 +"), vec![12]);
    assert_eq!(ok(": DROP 99 ; 1 drop"), vec![1, 99]);
}

#[test]
fn builtin_redefinition_can_use_old_builtin() {
    assert_eq!(ok(": dup dup dup ; 1 dup"), vec![1, 1, 1]);
    assert_eq!(ok(": - - 1 - ; 10 3 -"), vec![6]);
}

#[test]
fn snapshot_semantics() {
    let mut f = Forth::new();
    f.eval(": foo 5 ;").unwrap();
    f.eval(": bar foo ;").unwrap();
    f.eval(": foo 6 ;").unwrap();
    f.eval("bar foo").unwrap();
    assert_eq!(f.stack(), [5, 6]);
}

#[test]
fn snapshot_of_builtin() {
    assert_eq!(ok(": plus + ; : + - ; 5 3 plus 5 3 +"), vec![8, 2]);
}

#[test]
fn snapshot_through_several_layers() {
    let mut f = Forth::new();
    f.eval(": a 1 ; : b a a + ; : c b b * ;").unwrap();
    f.eval(": a 10 ; : b 0 ;").unwrap();
    f.eval("c a b").unwrap();
    assert_eq!(f.stack(), [4, 10, 0]);
}

#[test]
fn self_reference_uses_previous_meaning() {
    assert_eq!(ok(": foo 10 ; : foo foo 1 + ; foo"), vec![11]);
    assert_eq!(ok(": foo 10 ; : foo foo 1 + ; : foo foo 1 + ; foo"), vec![12]);
}

#[test]
fn self_reference_without_previous_meaning_is_unknown() {
    let mut f = Forth::new();
    assert_eq!(f.eval(": loop loop ;"), Err(Error::UnknownWord));
    assert_eq!(f.eval("loop"), Err(Error::UnknownWord));
}

#[test]
fn unknown_word_in_body_fails_at_definition_time() {
    let mut f = Forth::new();
    assert_eq!(f.eval(": foo bar ;"), Err(Error::UnknownWord));
    f.eval(": bar 7 ;").unwrap();
    assert_eq!(f.eval("foo"), Err(Error::UnknownWord));
}

#[test]
fn failed_redefinition_keeps_old_meaning() {
    let mut f = Forth::new();
    f.eval(": foo 1 ;").unwrap();
    assert_eq!(f.eval(": foo nonsense ;"), Err(Error::UnknownWord));
    f.eval("foo").unwrap();
    assert_eq!(f.stack(), [1]);
}

#[test]
fn numbers_cannot_be_defined() {
    assert_eq!(run(": 1 2 ;").0, Err(Error::InvalidWord));
    assert_eq!(run(": -1 2 ;").0, Err(Error::InvalidWord));
    let mut f = Forth::new();
    let _ = f.eval(": 5 6 ;");
    f.eval("5").unwrap();
    assert_eq!(f.stack(), [5]);
}

#[test]
fn word_names_that_merely_contain_digits_are_fine() {
    assert_eq!(ok(": 2x 2 * ; : x-1 1 - ; 5 2x x-1"), vec![9]);
}

#[test]
fn malformed_definitions() {
    assert_eq!(run(":").0, Err(Error::InvalidWord));
    assert_eq!(run(": foo 1 2").0, Err(Error::InvalidWord));
    assert_eq!(run("1 ;").0, Err(Error::InvalidWord));
    assert_eq!(run(": foo : bar ; ;").0, Err(Error::InvalidWord));
}

#[test]
fn unfinished_definition_is_not_created() {
    let mut f = Forth::new();
    assert_eq!(f.eval(": foo 1"), Err(Error::InvalidWord));
    assert_eq!(f.eval("foo ;"), Err(Error::UnknownWord));
}

#[test]
fn definitions_before_an_error_are_kept() {
    let mut f = Forth::new();
    assert_eq!(f.eval(": ok1 1 ; 1 0 / : never 2 ;"), Err(Error::DivisionByZero));
    f.eval("drop drop ok1").unwrap();
    assert_eq!(f.stack(), [1]);
    assert_eq!(f.eval("never"), Err(Error::UnknownWord));
}

#[test]
fn errors_inside_user_words() {
    assert_eq!(run(": bad 1 0 / ; 5 bad"), (Err(Error::DivisionByZero), vec![5, 1, 0]));
    assert_eq!(run(": two-drops drop drop ; 9 two-drops"), (Err(Error::StackUnderflow), vec![]));
    assert_eq!(run(": f 1 + ; f"), (Err(Error::StackUnderflow), vec![1]));
}

/// Runs `f` on another thread and fails if it takes longer than `secs`.
fn within<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(secs))
        .expect("took too long: definitions must not be expanded inline")
}

#[test]
fn long_redefinition_chain_is_cheap_to_define() {
    let stack = within(10, || {
        let mut f = Forth::new();
        f.eval(": a 1 ;").unwrap();
        for _ in 0..64 {
            f.eval(": a a a + ;").unwrap();
        }
        f.eval(": a 7 ; a").unwrap();
        f.stack().to_vec()
    });
    assert_eq!(stack, vec![7]);
}

#[test]
fn long_chain_evaluates_correctly() {
    let stack = within(10, || {
        let mut f = Forth::new();
        f.eval(": a 1 ;").unwrap();
        for _ in 0..20 {
            f.eval(": a a a + ;").unwrap();
        }
        f.eval("a").unwrap();
        f.stack().to_vec()
    });
    assert_eq!(stack, vec![1 << 20]);
}

#[test]
fn deep_chain_of_distinct_words() {
    let stack = within(10, || {
        let mut f = Forth::new();
        f.eval(": w0 1 + ;").unwrap();
        for i in 1..1000 {
            f.eval(&format!(": w{i} w{} ;", i - 1)).unwrap();
        }
        f.eval("0 w999").unwrap();
        f.stack().to_vec()
    });
    assert_eq!(stack, vec![1]);
}
