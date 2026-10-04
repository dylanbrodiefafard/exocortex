"""Checking filter arguments.

Filters report bad arguments by raising :class:`~inkwell.errors.FilterError`
with a message of the form ``filter '<name>': <problem>``; the engine adds
the template name and line. Use these helpers instead of converting
arguments by hand so every filter reports problems the same way.
"""

from inkwell.errors import FilterError


def fail(filter_name, message):
    raise FilterError(f"filter '{filter_name}': {message}")


def int_arg(filter_name, value, *, minimum=None):
    """Convert an argument to int. Strings of digits are accepted."""
    if isinstance(value, bool):
        number = None
    elif isinstance(value, int):
        number = value
    else:
        try:
            number = int(str(value).strip())
        except ValueError:
            number = None
    if number is None:
        fail(filter_name, f"expected an integer, got '{value}'")
    if minimum is not None and number < minimum:
        fail(filter_name, f"expected an integer >= {minimum}, got '{value}'")
    return number


def str_arg(filter_name, value):
    """Require a string argument."""
    if not isinstance(value, str):
        fail(filter_name, f"expected a string, got '{value}'")
    return value


def arity_error(spec, count):
    """The message for calling ``spec`` with the wrong number of arguments."""
    lo, hi = spec.min_args, spec.max_args
    if hi == 0:
        expected = "no arguments"
    elif lo == hi:
        expected = f"{lo} argument" + ("s" if lo != 1 else "")
    else:
        expected = f"{lo} to {hi} arguments"
    return f"filter '{spec.name}': expected {expected}, got {count}"
