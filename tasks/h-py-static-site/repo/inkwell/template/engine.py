"""Loading and rendering templates."""

from pathlib import Path

from inkwell.config import default_config
from inkwell.errors import FilterError, TemplateError
from inkwell.filters import FilterContext, arity_error, get_filter
from inkwell.template.context import Scope
from inkwell.template.parser import parse

MAX_INCLUDE_DEPTH = 10


class FileLoader:
    """Loads templates from a directory."""

    def __init__(self, directory):
        self.directory = Path(directory)

    def load(self, name):
        path = self.directory / name
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    def names(self):
        return sorted(p.relative_to(self.directory).as_posix() for p in self.directory.rglob("*.html"))


class DictLoader:
    """Loads templates from a dict of name to source (used by tests)."""

    def __init__(self, templates):
        self.templates = dict(templates)

    def load(self, name):
        return self.templates.get(name)

    def names(self):
        return sorted(self.templates)


class Template:
    def __init__(self, env, name, nodes):
        self.env = env
        self.name = name
        self.nodes = nodes

    def render(self, variables=None, **kwargs):
        scope = Scope({**(variables or {}), **kwargs})
        out = []
        _Renderer(self.env, self.name, 0).render_nodes(self.nodes, scope, out)
        return "".join(out)


class Environment:
    """Templates for one site.

    ``config`` is the :class:`~inkwell.config.SiteConfig` that filters
    receive through their :class:`~inkwell.filters.FilterContext`.
    """

    def __init__(self, config=None, loader=None):
        self.config = config if config is not None else default_config()
        self.loader = loader if loader is not None else FileLoader(self.config.template_dir)
        self._cache = {}

    def get_template(self, name, *, line=None, parent=None):
        if name not in self._cache:
            source = self.loader.load(name)
            if source is None:
                if parent is not None:
                    raise TemplateError(parent, line, f"template {name!r} not found")
                raise TemplateError(name, 0, "template not found")
            self._cache[name] = Template(self, name, parse(source, name))
        return self._cache[name]

    def from_string(self, source, name="<string>"):
        return Template(self, name, parse(source, name))

    def render(self, name, variables=None, **kwargs):
        return self.get_template(name).render(variables, **kwargs)


class _Renderer:
    def __init__(self, env, name, depth):
        self.env = env
        self.name = name
        self.depth = depth

    def render_nodes(self, nodes, scope, out):
        for node in nodes:
            node.render(self, scope, out)

    def evaluate(self, expression, scope):
        value = expression.value.evaluate(scope)
        for call in expression.filters:
            value = self.apply_filter(call, value, scope)
        return value

    def truthy(self, expression, scope):
        result = bool(self.evaluate(expression, scope))
        return not result if expression.negated else result

    def apply_filter(self, call, value, scope):
        spec = get_filter(call.name)
        if spec is None:
            raise TemplateError(self.name, call.line, f"unknown filter '{call.name}'")
        args = [arg.evaluate(scope) for arg in call.args]
        if not spec.min_args <= len(args) <= spec.max_args:
            raise TemplateError(self.name, call.line, arity_error(spec, len(args)))
        try:
            if spec.needs_context:
                ctx = FilterContext(config=self.env.config, page=scope.get("page"), template=self.name)
                return spec.func(ctx, value, *args)
            return spec.func(value, *args)
        except FilterError as exc:
            raise TemplateError(self.name, call.line, str(exc)) from exc

    def include(self, name, line, scope, out):
        if self.depth >= MAX_INCLUDE_DEPTH:
            raise TemplateError(self.name, line, f"includes nested more than {MAX_INCLUDE_DEPTH} deep")
        template = self.env.get_template(name, line=line, parent=self.name)
        _Renderer(self.env, template.name, self.depth + 1).render_nodes(template.nodes, scope, out)
