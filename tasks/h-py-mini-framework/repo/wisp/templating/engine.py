"""Template parsing and rendering."""

import re

from wisp.templating.filters import FILTERS, Markup, escape

_TOKEN = re.compile(r"({{.*?}}|{%.*?%})", re.DOTALL)
_FOR = re.compile(r"^for\s+([A-Za-z_]\w*)\s+in\s+(.+)$")
_ARG = re.compile(r'^"(.*)"$|^\'(.*)\'$|^(-?\d+)$')


class TemplateError(Exception):
    pass


class _Text:
    def __init__(self, text):
        self.text = text

    def render(self, ctx, out):
        out.append(self.text)


class _Expr:
    def __init__(self, source):
        self.source = source.strip()

    def render(self, ctx, out):
        out.append(escape(evaluate(self.source, ctx)))


class _For:
    def __init__(self, var, iterable, body):
        self.var, self.iterable, self.body = var, iterable, body

    def render(self, ctx, out):
        items = evaluate(self.iterable, ctx) or []
        for i, item in enumerate(items):
            inner = {**ctx, self.var: item, "loop": {"index": i + 1, "first": i == 0, "last": i == len(items) - 1}}
            for node in self.body:
                node.render(inner, out)


class _If:
    def __init__(self, cond, body, orelse):
        self.cond, self.body, self.orelse = cond, body, orelse

    def render(self, ctx, out):
        negate = self.cond.startswith("not ")
        value = evaluate(self.cond[4:] if negate else self.cond, ctx)
        branch = self.body if bool(value) != negate else self.orelse
        for node in branch:
            node.render(ctx, out)


def _lookup(name: str, ctx: dict):
    parts = name.split(".")
    if parts[0] not in ctx:
        raise TemplateError(f"undefined variable {parts[0]!r}")
    value = ctx[parts[0]]
    for attr in parts[1:]:
        if isinstance(value, dict):
            value = value.get(attr)
        else:
            value = getattr(value, attr, None)
    return value


def _literal(arg: str):
    m = _ARG.match(arg.strip())
    if not m:
        raise TemplateError(f"bad filter argument {arg!r}")
    if m.group(3) is not None:
        return m.group(3)
    return m.group(1) if m.group(1) is not None else m.group(2)


def evaluate(source: str, ctx: dict):
    head, *filters = [p.strip() for p in source.split("|")]
    value = _lookup(head, ctx)
    for spec in filters:
        name, _, argstr = spec.partition(":")
        if name not in FILTERS:
            raise TemplateError(f"unknown filter {name!r}")
        args = [_literal(a) for a in argstr.split(",")] if argstr else []
        value = FILTERS[name](value, *args)
    return value


def _parse(tokens, pos, stop):
    nodes = []
    while pos < len(tokens):
        tok = tokens[pos]
        if tok.startswith("{%"):
            stmt = tok[2:-2].strip()
            keyword = stmt.split(None, 1)[0] if stmt else ""
            if keyword in stop:
                return nodes, pos, keyword
            if keyword == "for":
                m = _FOR.match(stmt)
                if not m:
                    raise TemplateError(f"bad for tag: {stmt!r}")
                body, pos, end = _parse(tokens, pos + 1, {"endfor"})
                if end != "endfor":
                    raise TemplateError("unclosed for")
                nodes.append(_For(m.group(1), m.group(2).strip(), body))
            elif keyword == "if":
                body, pos, end = _parse(tokens, pos + 1, {"else", "endif"})
                orelse = []
                if end == "else":
                    orelse, pos, end = _parse(tokens, pos + 1, {"endif"})
                if end != "endif":
                    raise TemplateError("unclosed if")
                nodes.append(_If(stmt[2:].strip(), body, orelse))
            else:
                raise TemplateError(f"unknown tag {keyword!r}")
        elif tok.startswith("{{"):
            nodes.append(_Expr(tok[2:-2]))
        elif tok:
            nodes.append(_Text(tok))
        pos += 1
    return nodes, pos, None


class Template:
    def __init__(self, source: str, name: str = "<string>"):
        self.name = name
        nodes, _, end = _parse(_TOKEN.split(source), 0, set())
        if end is not None:
            raise TemplateError(f"unexpected {{% {end} %}} in {name}")
        self._nodes = nodes

    def render(self, **context) -> Markup:
        out: list[str] = []
        for node in self._nodes:
            node.render(context, out)
        return Markup("".join(out))
