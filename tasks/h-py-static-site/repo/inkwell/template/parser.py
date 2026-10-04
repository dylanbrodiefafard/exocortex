"""Building the syntax tree from tokens."""

import re

from inkwell.errors import TemplateError
from inkwell.template import nodes
from inkwell.template.expressions import parse_expression
from inkwell.template.lexer import OUTPUT, TAG, TEXT, tokenize

_FOR = re.compile(r"^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$")
_INCLUDE = re.compile(r"""^include\s+("([^"]+)"|'([^']+)')$""")


class _Parser:
    def __init__(self, tokens, name):
        self.tokens = tokens
        self.name = name
        self.pos = 0

    def fail(self, line, message):
        raise TemplateError(self.name, line, message)

    def parse(self, until=()):
        body = []
        while self.pos < len(self.tokens):
            token = self.tokens[self.pos]
            if token.kind == TEXT:
                body.append(nodes.Text(token.value))
                self.pos += 1
            elif token.kind == OUTPUT:
                body.append(nodes.Output(parse_expression(token.value, self.name, token.line), token.line))
                self.pos += 1
            elif token.kind == TAG:
                keyword = token.value.split(None, 1)[0] if token.value else ""
                if keyword in until:
                    return body, keyword, token
                self.pos += 1
                body.append(self.tag(keyword, token))
        if until:
            return body, None, None
        return body, None, None

    def block(self, opener, enders):
        body, keyword, token = self.parse(until=enders)
        if keyword is None:
            self.fail(opener.line, f"{{% {opener.value.split()[0]} %}} is not closed")
        self.pos += 1
        return body, keyword, token

    def tag(self, keyword, token):
        if keyword == "if":
            condition = parse_expression(token.value[2:], self.name, token.line, allow_not=True)
            body, ender, _ = self.block(token, ("else", "endif"))
            orelse = []
            if ender == "else":
                orelse, _, _ = self.block(token, ("endif",))
            return nodes.If(condition, body, orelse, token.line)
        if keyword == "for":
            match = _FOR.match(token.value)
            if not match:
                self.fail(token.line, "expected {% for name in expression %}")
            iterable = parse_expression(match.group(2), self.name, token.line)
            body, ender, _ = self.block(token, ("empty", "endfor"))
            empty = []
            if ender == "empty":
                empty, _, _ = self.block(token, ("endfor",))
            return nodes.For(match.group(1), iterable, body, empty, token.line)
        if keyword == "include":
            match = _INCLUDE.match(token.value)
            if not match:
                self.fail(token.line, 'expected {% include "name" %}')
            return nodes.Include(match.group(2) or match.group(3), token.line)
        if keyword in ("else", "endif", "endfor", "empty"):
            self.fail(token.line, f"unexpected {{% {keyword} %}}")
        self.fail(token.line, f"unknown tag {keyword!r}")


def parse(source, name):
    """Parse template source into a list of nodes."""
    body, _, _ = _Parser(tokenize(source, name), name).parse()
    return body
