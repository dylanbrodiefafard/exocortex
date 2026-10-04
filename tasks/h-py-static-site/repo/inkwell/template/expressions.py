"""Expressions inside ``{{ }}`` and tags.

An expression is a value followed by any number of filter calls::

    page.title | default:"Untitled" | upper

A value is a dotted variable path, a quoted string or an integer. Filter
arguments are values too. Conditions in ``{% if %}`` may start with
``not``.
"""

import re
from dataclasses import dataclass, field

from inkwell.errors import TemplateError

_TOKEN = re.compile(
    r"""\s*(?:
        (?P<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
      | (?P<number>-?\d+)
      | (?P<name>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)
      | (?P<punct>[|:,])
    )""",
    re.VERBOSE,
)


@dataclass(frozen=True)
class Literal:
    value: object

    def evaluate(self, scope):
        return self.value


@dataclass(frozen=True)
class Variable:
    path: str

    def evaluate(self, scope):
        return scope.lookup(self.path)


@dataclass(frozen=True)
class FilterCall:
    name: str
    args: tuple
    line: int


@dataclass(frozen=True)
class Expression:
    value: object
    filters: tuple = field(default_factory=tuple)
    negated: bool = False


def _lex(text, name, line):
    tokens = []
    pos = 0
    text = text.rstrip()
    while pos < len(text):
        match = _TOKEN.match(text, pos)
        if not match or match.end() == pos:
            raise TemplateError(name, line, f"unexpected {text[pos:].strip()[:20]!r} in expression")
        kind = match.lastgroup
        tokens.append((kind, match.group(kind)))
        pos = match.end()
    return tokens


def _value(token, name, line):
    kind, text = token
    if kind == "string":
        return Literal(bytes(text[1:-1], "utf-8").decode("unicode_escape") if "\\" in text else text[1:-1])
    if kind == "number":
        return Literal(int(text))
    if kind == "name":
        if text in ("true", "false"):
            return Literal(text == "true")
        if text == "none":
            return Literal(None)
        return Variable(text)
    raise TemplateError(name, line, f"expected a value, got {text!r}")


def parse_expression(text, name, line, *, allow_not=False):
    tokens = _lex(text, name, line)
    negated = False
    if allow_not and len(tokens) > 1 and tokens[0] == ("name", "not"):
        negated = True
        tokens = tokens[1:]
    if not tokens:
        raise TemplateError(name, line, "empty expression")
    value = _value(tokens[0], name, line)
    filters = []
    i = 1
    while i < len(tokens):
        if tokens[i] != ("punct", "|"):
            raise TemplateError(name, line, f"expected | before {tokens[i][1]!r}")
        if i + 1 >= len(tokens) or tokens[i + 1][0] != "name":
            raise TemplateError(name, line, "expected a filter name after |")
        filter_name = tokens[i + 1][1]
        i += 2
        args = []
        if i < len(tokens) and tokens[i] == ("punct", ":"):
            i += 1
            while True:
                if i >= len(tokens):
                    raise TemplateError(name, line, f"missing argument for filter '{filter_name}'")
                args.append(_value(tokens[i], name, line))
                i += 1
                if i < len(tokens) and tokens[i] == ("punct", ","):
                    i += 1
                    continue
                break
        filters.append(FilterCall(filter_name, tuple(args), line))
    return Expression(value, tuple(filters), negated)
