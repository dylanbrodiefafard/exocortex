"""Template filters.

Importing this package registers every built-in filter.
"""

from inkwell.filters.args import arity_error
from inkwell.filters.registry import FilterContext, FilterSpec, all_filters, get_filter, register_filter

from inkwell.filters import collections, dates, html, strings  # noqa: E402,F401  (registers filters)

__all__ = ["FilterContext", "FilterSpec", "all_filters", "arity_error", "get_filter", "register_filter"]
