# The rill language

A rill program is one expression. It is type checked before it runs.

```
let prices = [12.5, 8.0, 3.25] in
let total = sum(prices) in
if total > 20 then "expensive: " ++ str(total) else "fine"
```

## Values and types

| Type | Literals | Notes |
|---|---|---|
| `Int` | `0`, `42` | 64-bit. Overflow is a runtime error, never a wrap-around. |
| `Float` | `1.5`, `2.0` | 64-bit. Results must be finite. |
| `Bool` | `true`, `false` | |
| `Str` | `"a\tb"` | Escapes: `\n`, `\t`, `\"`, `\\`. |
| `List[T]` | `[1, 2, 3]`, `[]` | All items have the same type. |

There are no negative literals: `-1` applies `-` to `1`.

Values print as literals: `3`, `2.5`, `4.0`, `"text"`, `[1, 2]`. A float
always prints with a decimal point (or an exponent).

## Expressions

- `let x = e in body` binds `x` in `body`.
- `if c then a else b`: `c` must be `Bool`; both branches must have the same
  type. Only the chosen branch is evaluated.
- `f(a, b)` calls a builtin (below).
- `xs[i]` indexes a list or a string (by character). Negative indexes count
  from the end. An index out of range is a runtime error.
- `# comment` runs to the end of the line.

`if` and `let` extend as far to the right as possible:
`if c then 1 else 2 + 3` is `if c then 1 else (2 + 3)`.

## Operators

From tightest to loosest binding (`rill ops` prints this table):

| Operator | Precedence | Associativity | Meaning |
|---|---|---|---|
| `-x`, `not x` | 70 | prefix | negation, logical not |
| `*` `/` `%` | 60 | left | multiplication, division, remainder |
| `+` `-` | 50 | left | addition, subtraction |
| `++` | 40 | right | concatenation of two strings or two lists |
| `==` `!=` `<` `<=` `>` `>=` | 30 | none | comparison; cannot be chained (`a < b < c` is an error) |
| `and` | 20 | left | logical and, short-circuit |
| `or` | 10 | left | logical or, short-circuit |

Calls and indexing bind tighter than every operator.

### Arithmetic

`+ - * / %` take two numbers. Two `Int`s give an `Int`; if either operand is
a `Float`, the other is converted and the result is a `Float`. Integer
division truncates toward zero and `%` takes the sign of the left operand.
Errors, reported at the operator:

- `integer overflow`: an `Int` result does not fit in 64 bits.
- `division by zero`: `/` or `%` with a zero right operand.
- `result is not a finite number`: a `Float` result is infinite or NaN.

The builtins `abs`, `sum` and `pow` follow the same rules and report the
same errors.

### Comparison and logic

`==` and `!=` compare values of the same type (an `Int` and a `Float` compare
by value). `<`, `<=`, `>`, `>=` compare two numbers or two strings. `and`,
`or` and `not` take `Bool`s.

## Builtins

| Function | Result |
|---|---|
| `len(Str \| List[T]) -> Int` | number of characters or items |
| `abs(N) -> N` | absolute value |
| `min(A, B)`, `max(A, B)` | the smaller / larger number; `Float` if either is |
| `pow(A, B)` | `A` to the power `B`. Two `Int`s give an `Int` (a negative exponent is the runtime error `negative exponent in integer power`); otherwise a `Float`. |
| `sum(List[N]) -> N` | sum of the items (`0` for `[]`) |
| `str(T) -> Str` | the value as text (strings unchanged) |
| `int(Int \| Float \| Str) -> Int` | truncates floats, parses strings |
| `float(Int \| Float \| Str) -> Float` | converts or parses |
| `upper(Str)`, `lower(Str)` | case conversion |
| `range(Int, Int) -> List[Int]` | `range(1, 4)` is `[1, 2, 3]` |

## Errors

Every error is reported as `<kind> error at <line>:<column>: <message>`, where
kind is `syntax`, `type` or `runtime`. Errors about an operator (type
mismatches, overflow, division by zero) point at the operator itself; errors
in a builtin call point at the call; index errors point at the index.

```
$ rill eval '1 + "a"'
type error at 1:3: operator `+` expects numbers, found Int and Str
$ rill eval '[1, 2][5]'
runtime error at 1:8: index 5 is out of range for length 2
```

## Formatting

`rill fmt` prints a program in canonical form: one space around binary
operators, `, ` between items and arguments, and parentheses only where they
are needed for the output to parse back to the same tree. The one
exception: an `if` or `let` used as an operand (of an operator, or as the
thing being indexed) is always parenthesized.

```
$ rill fmt '((1 + 2)) * (3)'
(1 + 2) * 3
$ rill fmt '(a ++ b) ++ c'
(a ++ b) ++ c
$ rill fmt '-(x)'
-x
```

`rill fmt` is idempotent and preserves meaning: formatting the output again
gives the same text, and it parses to the same tree as the input.
