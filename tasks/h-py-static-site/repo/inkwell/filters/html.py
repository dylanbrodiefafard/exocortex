"""HTML filters."""

from inkwell.filters.args import str_arg
from inkwell.filters.registry import register_filter
from inkwell.site.urls import absolute_url
from inkwell.text.html import Markup, escape, strip_tags


@register_filter("escape")
def escape_filter(value):
    """Escape HTML special characters, even in safe values."""
    return Markup(escape(str(value) if isinstance(value, Markup) else value))


@register_filter("safe")
def safe(value):
    """Mark the value as HTML that must not be escaped."""
    return Markup("" if value is None else str(value))


@register_filter("striptags")
def striptags(value):
    """Plain text of an HTML fragment."""
    return strip_tags("" if value is None else value)


@register_filter("absurl", needs_context=True)
def absurl(ctx, value):
    """Absolute URL of a site path, using [site] base_url."""
    return absolute_url(ctx.config.base_url, "" if value is None else value)


@register_filter("link", args=(1, 1))
def link(value, text):
    """An <a> element pointing at the value."""
    href = escape(value)
    return Markup(f'<a href="{href}">{escape(str_arg("link", text))}</a>')
