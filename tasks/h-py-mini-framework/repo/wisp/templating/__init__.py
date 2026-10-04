"""A deliberately tiny template language.

``{{ expr }}`` prints an expression (auto-escaped), where ``expr`` is a dotted
name optionally followed by ``|filter`` calls. ``{% for x in items %}...{% endfor %}``
and ``{% if name %}...{% else %}...{% endif %}`` are supported.
"""

from wisp.templating.engine import Template, TemplateError
from wisp.templating.filters import FILTERS
from wisp.templating.loader import TemplateLoader

__all__ = ["FILTERS", "Template", "TemplateError", "TemplateLoader"]
