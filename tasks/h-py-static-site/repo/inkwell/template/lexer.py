"""Splitting template source into text, output, tag and comment tokens."""

import re
from dataclasses import dataclass

from inkwell.errors import TemplateError

TEXT = "text"
OUTPUT = "output"
TAG = "tag"

_OPENERS = re.compile(r"\{\{|\{%|\{#")
_CLOSERS = {"{{": "}}", "{%": "%}", "{#": "#}"}


@dataclass(frozen=True)
class Token:
    kind: str
    value: str
    line: int


def tokenize(source, name):
    tokens = []
    pos = 0
    line = 1
    while True:
        match = _OPENERS.search(source, pos)
        if not match:
            if pos < len(source):
                tokens.append(Token(TEXT, source[pos:], line))
            return tokens
        if match.start() > pos:
            text = source[pos:match.start()]
            tokens.append(Token(TEXT, text, line))
            line += text.count("\n")
        opener = match.group(0)
        closer = _CLOSERS[opener]
        end = source.find(closer, match.end())
        if end < 0:
            raise TemplateError(name, line, f"{opener} is not closed with {closer}")
        inner = source[match.end():end]
        if opener == "{{":
            tokens.append(Token(OUTPUT, inner.strip(), line))
        elif opener == "{%":
            tokens.append(Token(TAG, inner.strip(), line))
        line += inner.count("\n")
        pos = end + len(closer)
