# chroma

CSS color parsing, conversion and WCAG contrast checks for the design-token pipeline.

```rust
let c = chroma::parse("hsl(270, 50%, 40%)")?;
assert_eq!(c.to_hex(), "#663399");
```

## Parsing

`chroma::parse` accepts, case-insensitively and ignoring surrounding whitespace:

- hex: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (short forms repeat each digit);
- `rgb(r, g, b)` / `rgba(r, g, b, a)`: channels are all numbers (`0..=255`) or all
  percentages, clamped and rounded to nearest; alpha is a number `0..=1` or a percentage, clamped;
- `hsl(h, s%, l%)` / `hsla(h, s%, l%, a)`: hue in degrees (optional `deg` suffix), any
  finite value, wrapping around the circle (`-120` is the same hue as `240`, `480` the same
  as `120`); saturation and lightness are percentages clamped to `0..=100`;
- the 148 CSS named colors and `transparent`.

## Output

- `Rgba::to_hex()`: lowercase `#rrggbb` for opaque colors, `#rrggbbaa` otherwise; the
  alpha byte is `alpha * 255` rounded to nearest, so `#rrggbbaa` input round-trips.
- `Rgba::to_css()` / `Display`: `rgb(r, g, b)` or `rgba(r, g, b, a)` with up to three alpha decimals.
- `Rgba::to_hsla()` / `Hsla::to_rgba()`: standard sRGB <-> HSL conversion; channels are rounded to nearest.
  `Hsla::new` normalizes its arguments (hue wrapped into `0..360`).

## Contrast

`contrast::relative_luminance` and `contrast::ratio` follow WCAG 2.x;
`contrast::level` maps a ratio to `Fail`/`AA`/`AAA` (normal text 4.5/7, large text 3/4.5).

## Legacy API

`chroma::legacy` is the 0.3 tuple API. It is deprecated but still supported until 1.0, and
`tests/legacy_api.rs` keeps it covered, so `cargo test` prints a deprecation warning for
every legacy call in that file. Those warnings are expected.

## Testing

CI runs `cargo test --offline --no-fail-fast`.
