# Routing

Routes are registered with `app.route(pattern, methods=..., name=...)` or the
`app.get` / `app.post` shortcuts. A pattern is a `/`-separated list of
segments. Each segment is either static text or a parameter `<name>` /
`<converter:name>`.

## Converters

| Converter | Matches | Python value |
|---|---|---|
| `str` (default) | one non-empty segment | `str` |
| `int` | one segment of ASCII digits | `int` |
| `slug` | one segment of lowercase letters, digits and single hyphens | `str` |
| `path` | one or more segments, slashes included; must be the last segment | `str` |

## Matching

1. The request path is split on `/`. A single trailing slash on the request
   path is ignored, so `/books/7/` matches exactly what `/books/7` matches.
   The root path `/` only matches the pattern `/`.
2. Each captured parameter value is percent-decoded as UTF-8 (`+` is a
   literal plus sign in paths, not a space) *after* the path has been split,
   so an encoded slash (`%2F`) is part of the value rather than a separator.
   Malformed escapes are kept literally. Converters see the decoded value.
3. When several routes match, the most specific wins. Routes are compared
   segment by segment, left to right: static text beats `int`, which beats
   `slug`, which beats `str`, which beats `path`. Routes that tie keep their
   registration order.
4. If some route matches the path but none allows the method, the router
   raises `MethodNotAllowed` with an `Allow` header listing the allowed
   methods. Otherwise it raises `NotFound`.

Routes that allow `GET` also allow `HEAD`.

## Reversing

`app.url_for(name, **params)` builds a path for a named route (the name
defaults to the handler's function name). Parameter values are
percent-encoded.
