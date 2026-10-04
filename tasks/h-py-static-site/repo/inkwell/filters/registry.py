"""The filter registry.

A filter is a function registered with :func:`register_filter`. The first
line of its docstring is the summary shown by ``inkwell filters``.
"""

from dataclasses import dataclass
from typing import Callable

_REGISTRY = {}


@dataclass(frozen=True)
class FilterSpec:
    name: str
    func: Callable
    min_args: int
    max_args: int
    needs_context: bool
    summary: str


@dataclass(frozen=True)
class FilterContext:
    """Passed as the first argument to filters registered with
    ``needs_context=True``."""

    config: object
    page: object
    template: str


def register_filter(name, *, args=(0, 0), needs_context=False):
    """Register the decorated function as the filter ``name``.

    ``args`` is the ``(minimum, maximum)`` number of arguments the filter
    accepts after the value; the engine checks it before calling. With
    ``needs_context=True`` the function is called as
    ``func(ctx, value, *args)`` with a :class:`FilterContext`.
    """
    min_args, max_args = args

    def decorate(func):
        if name in _REGISTRY:
            raise ValueError(f"filter {name!r} is already registered")
        doc = (func.__doc__ or "").strip()
        summary = doc.splitlines()[0].strip() if doc else ""
        _REGISTRY[name] = FilterSpec(name, func, min_args, max_args, needs_context, summary)
        return func

    return decorate


def get_filter(name):
    """The :class:`FilterSpec` registered as ``name``, or None."""
    return _REGISTRY.get(name)


def all_filters():
    """Every registered filter, sorted by name."""
    return [_REGISTRY[name] for name in sorted(_REGISTRY)]
