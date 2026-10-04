"""The content markup: a small Markdown subset.

Block syntax: ``#`` to ``######`` headings, paragraphs separated by blank
lines, ``-`` or ``*`` bullet lists, ``1.`` numbered lists, ``>`` quotes,
fenced code blocks between ``` lines, and raw HTML blocks (lines starting
with ``<`` are passed through unchanged). Inline syntax: ``**strong**``,
``*emphasis*``, ```code``` and ``[text](url)``.
"""

import html
import re

from inkwell.text.html import Markup

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^[-*]\s+(.*)$")
_NUMBERED = re.compile(r"^\d+\.\s+(.*)$")
_CODE = re.compile(r"`([^`]+)`")
_STRONG = re.compile(r"\*\*(.+?)\*\*")
_EM = re.compile(r"\*(.+?)\*")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


def render_inline(text):
    """Convert inline markup in one block of text to HTML."""
    out = []
    pos = 0
    for match in _CODE.finditer(text):
        out.append(_inline_no_code(text[pos:match.start()]))
        out.append("<code>" + html.escape(match.group(1), quote=False) + "</code>")
        pos = match.end()
    out.append(_inline_no_code(text[pos:]))
    return "".join(out)


def _inline_no_code(text):
    text = html.escape(text, quote=False)
    text = _LINK.sub(lambda m: f'<a href="{html.escape(m.group(2))}">{m.group(1)}</a>', text)
    text = _STRONG.sub(r"<strong>\1</strong>", text)
    return _EM.sub(r"<em>\1</em>", text)


def render(text):
    """Convert a whole document to HTML."""
    lines = text.splitlines()
    blocks = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        if stripped.startswith("```"):
            i, block = _fenced(lines, i)
        elif stripped.startswith("<"):
            i, block = _raw_html(lines, i)
        elif _HEADING.match(stripped):
            m = _HEADING.match(stripped)
            level = len(m.group(1))
            block = f"<h{level}>{render_inline(m.group(2))}</h{level}>"
            i += 1
        elif _BULLET.match(stripped):
            i, block = _list(lines, i, _BULLET, "ul")
        elif _NUMBERED.match(stripped):
            i, block = _list(lines, i, _NUMBERED, "ol")
        elif stripped.startswith(">"):
            i, block = _quote(lines, i)
        else:
            i, block = _paragraph(lines, i)
        blocks.append(block)
    return Markup("\n".join(blocks))


def _fenced(lines, i):
    body = []
    i += 1
    while i < len(lines) and not lines[i].strip().startswith("```"):
        body.append(lines[i])
        i += 1
    code = html.escape("\n".join(body), quote=False)
    return i + 1, f"<pre><code>{code}</code></pre>"


def _raw_html(lines, i):
    body = []
    while i < len(lines) and lines[i].strip():
        body.append(lines[i])
        i += 1
    return i, "\n".join(body)


def _list(lines, i, pattern, tag):
    items = []
    while i < len(lines):
        m = pattern.match(lines[i].strip())
        if not m:
            break
        items.append(f"<li>{render_inline(m.group(1))}</li>")
        i += 1
    return i, f"<{tag}>" + "".join(items) + f"</{tag}>"


def _quote(lines, i):
    body = []
    while i < len(lines) and lines[i].strip().startswith(">"):
        body.append(lines[i].strip()[1:].strip())
        i += 1
    return i, "<blockquote>" + render("\n".join(body)) + "</blockquote>"


def _paragraph(lines, i):
    body = []
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith(("```", "<", ">")) or _HEADING.match(stripped):
            break
        if body and (_BULLET.match(stripped) or _NUMBERED.match(stripped)):
            break
        body.append(stripped)
        i += 1
    return i, "<p>" + render_inline(" ".join(body)) + "</p>"
