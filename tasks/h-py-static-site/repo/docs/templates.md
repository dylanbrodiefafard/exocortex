# Templates

Templates are HTML files in `build.template_dir`. Output is HTML-escaped
unless the value is marked safe (see the `safe` filter); content bodies
(`page.content`) are already safe.

## Syntax

- `{{ expression }}` outputs a value.
- `{% if expression %} ... {% else %} ... {% endif %}`; the condition may
  start with `not`.
- `{% for name in expression %} ... {% empty %} ... {% endfor %}`; inside the
  loop `loop.index`, `loop.first`, `loop.last` and `loop.length` are set.
- `{% include "partials/header.html" %}` renders another template with the
  same variables.
- `{# comment #}` is dropped.

An expression is a value followed by filters:

```
{{ page.title | default:"Untitled" | upper }}
{{ post.content | striptags | truncatewords:30 }}
```

A value is a dotted variable path (`page.title`, `site.base_url`), a quoted
string, an integer, `true`, `false` or `none`. Missing variables are empty.
Filters are documented in `docs/filters.md`.

## Variables

| Template | Variables |
|---|---|
| every template | `site` (the configuration), `posts` (all posts, newest first), `tags` |
| `post.html`, `page.html` | `page` |
| `index.html` | `entries` (posts on this index page), `pagination` |
| `tag.html` | `tag` (`tag.name`, `tag.url`, `tag.posts`) |

## Errors

Template problems are reported as `<template>:<line>: <message>`.
