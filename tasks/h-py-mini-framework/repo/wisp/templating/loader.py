"""Load templates from a directory, with caching."""

from pathlib import Path

from wisp.templating.engine import Template, TemplateError


class TemplateLoader:
    def __init__(self, directory):
        self.directory = Path(directory)
        self._cache: dict[str, Template] = {}

    def get(self, name: str) -> Template:
        if name not in self._cache:
            path = (self.directory / name).resolve()
            if self.directory.resolve() not in path.parents:
                raise TemplateError(f"template outside loader directory: {name!r}")
            if not path.is_file():
                raise TemplateError(f"template not found: {name!r}")
            self._cache[name] = Template(path.read_text(encoding="utf-8"), name=name)
        return self._cache[name]

    def render(self, template_name: str, /, **context) -> str:
        return self.get(template_name).render(**context)
