"""Template syntax tree and rendering."""

from dataclasses import dataclass

from inkwell.text.html import escape


@dataclass
class Text:
    text: str

    def render(self, renderer, scope, out):
        out.append(self.text)


@dataclass
class Output:
    expression: object
    line: int

    def render(self, renderer, scope, out):
        value = renderer.evaluate(self.expression, scope)
        if value is None:
            return
        if isinstance(value, bool):
            value = "true" if value else "false"
        out.append(escape(value))


@dataclass
class If:
    condition: object
    body: list
    orelse: list
    line: int

    def render(self, renderer, scope, out):
        branch = self.body if renderer.truthy(self.condition, scope) else self.orelse
        renderer.render_nodes(branch, scope, out)


@dataclass
class For:
    target: str
    iterable: object
    body: list
    empty: list
    line: int

    def render(self, renderer, scope, out):
        items = renderer.evaluate(self.iterable, scope)
        items = list(items) if items else []
        if not items:
            renderer.render_nodes(self.empty, scope, out)
            return
        for index, item in enumerate(items):
            loop = {
                "index": index + 1,
                "first": index == 0,
                "last": index == len(items) - 1,
                "length": len(items),
            }
            with scope.push({self.target: item, "loop": loop}):
                renderer.render_nodes(self.body, scope, out)


@dataclass
class Include:
    name: str
    line: int

    def render(self, renderer, scope, out):
        renderer.include(self.name, self.line, scope, out)
