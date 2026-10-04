# Filters

Filters transform a value inside `{{ }}`: `{{ value | name }}`, or with
arguments `{{ value | name:arg1,arg2 }}`. Arguments are quoted strings,
integers or variable paths.

`python3 -m inkwell filters` lists every filter with a one-line summary.

## Errors

A filter called with the wrong number of arguments, or with an argument it
cannot use, stops the build with an error of the form
`<template>:<line>: filter '<name>': <problem>`, for example:

```
index.html:12: filter 'truncatewords': expected 1 argument, got 0
index.html:14: filter 'truncatewords': expected an integer >= 1, got 'ten'
```

## Strings

### `upper`
Uppercase the text.

### `lower`
Lowercase the text.

### `title`
Capitalize the first letter of each word.

### `trim`
Remove leading and trailing whitespace.

### `default`
`{{ page.subtitle | default:"none" }}`: the argument when the value is
missing, empty or an empty list.

### `replace`
`{{ value | replace:"old","new" }}`: replace every occurrence.

### `truncate`
`{{ value | truncate:80 }}`: at most N characters (N >= 4) including a
trailing `...`, cut at a word boundary.

### `truncatewords`
`{{ value | truncatewords:30 }}`: the first N words (N >= 1). Whitespace is
collapsed; when words were dropped, trailing `, ; : -` is removed from the
last word and ` ...` is appended.

### `wordcount`
Number of words.

### `readingtime`
`{{ page.content | striptags | readingtime }}`: minutes needed to read the
text at 200 words per minute (or the given rate), at least 1.

### `slugify`
URL slug: ASCII, lowercase, words joined by `-`.

## HTML

### `escape`
Escape HTML special characters, even in a value marked safe.

### `safe`
Mark the value as HTML so it is output unescaped.

### `striptags`
The plain text of an HTML fragment: tags and comments removed, `<script>`
and `<style>` contents dropped, block elements (`<p>`, `<li>`, ...) separate
words, entities decoded, whitespace collapsed. The result is plain text and
is escaped on output.

### `absurl`
`{{ page.url | absurl }}`: absolute URL using `site.base_url`.

### `link`
`{{ page.url | link:page.title }}`: an `<a>` element.

## Dates

### `date`
`{{ page.date | date }}` or `{{ page.date | date:"%Y" }}`: format a date.
Without an argument the format is `build.date_format`.

### `isodate`
A date as `YYYY-MM-DD`.

### `year`
The year of a date.

## Lists

### `join`
Join the items with the argument (default `, `).

### `length`
Number of items (or characters).

### `first`
The first item.

### `last`
The last item.

### `reverse`
The items in reverse order.

### `limit`
`{{ posts | limit:5 }}`: the first N items.

### `sort`
Sort the items, or by an attribute: `{{ tags | sort:"name" }}`.

### `where`
`{{ posts | where:"tags","python" }}`: items whose attribute equals the
second argument (or contains it, for list attributes).
