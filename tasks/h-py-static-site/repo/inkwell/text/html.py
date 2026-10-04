"""HTML helpers: escaping and extracting text."""

import html
from html.parser import HTMLParser

from inkwell.text.words import collapse_whitespace


class Markup(str):
    """A string that is already safe HTML and is output without escaping."""

    def __repr__(self):
        return f"Markup({str.__repr__(self)})"


def escape(value):
    """Escape ``value`` for HTML unless it is already :class:`Markup`."""
    if isinstance(value, Markup):
        return value
    return Markup(html.escape("" if value is None else str(value), quote=True))


_SKIP = {"script", "style"}
_BLOCK = {
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
    "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
    "td", "th", "tr", "ul",
}


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self._skipping += 1
        elif tag in _BLOCK:
            self.parts.append(" ")

    def handle_startendtag(self, tag, attrs):
        if tag in _BLOCK:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in _SKIP:
            self._skipping = max(0, self._skipping - 1)
        elif tag in _BLOCK:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self._skipping:
            self.parts.append(data)


def strip_tags(markup):
    """Return the text of an HTML fragment.

    Tags and comments are removed, the contents of ``<script>`` and
    ``<style>`` are dropped, block-level elements separate words, entities
    are decoded and whitespace is collapsed.
    """
    parser = _TextExtractor()
    parser.feed(str(markup))
    parser.close()
    return collapse_whitespace("".join(parser.parts))
