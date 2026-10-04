# Configuration

A site is configured by an INI file, usually `site.ini` next to the content.
Every key has a default, so the file only lists what it changes. Unknown
sections and keys are errors.

Relative directories are resolved against the folder containing `site.ini`.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `site.title` | `Untitled` | Site title, used in templates and the feed. Must not be empty. |
| `site.base_url` | `/` | Prefix for absolute URLs (the `absurl` filter, the feed). Must start with `/`, `http://` or `https://` and end with `/`. |
| `site.author` | (empty) | Default author name. |
| `site.language` | `en` | Value for `<html lang>`. |
| `build.content_dir` | `content` | Where content files (`*.md`) live. |
| `build.template_dir` | `templates` | Where templates live. |
| `build.output_dir` | `public` | Where the site is written. Deleted and recreated by `inkwell build`. |
| `build.date_format` | `%B %d, %Y` | Default format of the `date` filter (`strftime` syntax). |
| `build.posts_per_page` | `10` | Posts per index page. Positive integer. |
| `build.feed_items` | `20` | Posts in `feed.xml`. Positive integer. |
| `build.drafts` | `no` | Include pages with `draft: true` (`yes`/`no`). |

## Errors

Problems are reported as `<file>: [<section>] <key>: <message>`, for example:

```
site.ini: [build] posts_per_page: must be a positive integer, got '0'
site.ini: [build] colour: unknown key
```

## Example

```ini
[site]
title = Field Notes
base_url = https://notes.example.org/

[build]
posts_per_page = 5
date_format = %d %b %Y
```
