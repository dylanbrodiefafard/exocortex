# inkwell

A small static site generator. Pages are written in a lightweight markup
with front matter, rendered through templates and written as plain HTML.

```
python3 -m inkwell build --config examples/blog/site.ini
python3 -m inkwell filters
python3 -m inkwell check --config examples/blog/site.ini
```

- `docs/configuration.md`: the `site.ini` file.
- `docs/templates.md`: template syntax.
- `docs/filters.md`: the filters available in templates.

## Layout

| Path | What |
|---|---|
| `inkwell/config.py` | Loading and validating `site.ini` |
| `inkwell/content/` | Front matter, markup conversion, page loading |
| `inkwell/template/` | Template lexer, parser and renderer |
| `inkwell/filters/` | Template filters and their registry |
| `inkwell/text/` | Text helpers shared by filters and content |
| `inkwell/site/` | Building the whole site |
| `inkwell/cli.py` | Command line entry point |

## Tests

```
python3 -m unittest discover -q -s tests -t .
```

No dependencies beyond the Python 3.11 standard library.
