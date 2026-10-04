# rill

A small statically typed expression language: lexer, parser, type checker,
tree-walking evaluator and formatter.

```
cargo run -q -- eval 'let xs = range(1, 6) in sum(xs) * 2'
cargo run -q -- type '[1.5, 2.0]'
cargo run -q -- fmt '((1 + 2)) * (3)'
cargo run -q -- ops
```

The language is described in [docs/language.md](docs/language.md).

## Layout

- `src/syntax/`: tokens, lexer, operator table (`ops.rs`), syntax tree,
  parser, printer.
- `src/types/`: types and the type checker.
- `src/eval/`: values, checked arithmetic, the evaluator.
- `src/builtins.rs`: builtin functions.
- `src/error.rs`, `src/span.rs`: errors and source positions.

## Tests

```
cargo test --offline
```

No dependencies.
