"""Loading and validating ``site.ini``.

Every key has a default in :data:`DEFAULTS`; a site file only lists what it
changes. Unknown sections and keys are errors, so typos do not go unnoticed.
See docs/configuration.md.
"""

import configparser
from dataclasses import dataclass
from pathlib import Path

from inkwell.errors import ConfigError

DEFAULTS = {
    "site": {
        "title": "Untitled",
        "base_url": "/",
        "author": "",
        "language": "en",
    },
    "build": {
        "content_dir": "content",
        "template_dir": "templates",
        "output_dir": "public",
        "date_format": "%B %d, %Y",
        "posts_per_page": "10",
        "feed_items": "20",
        "drafts": "no",
    },
}

_TRUE = {"yes", "true", "on", "1"}
_FALSE = {"no", "false", "off", "0"}


@dataclass(frozen=True)
class SiteConfig:
    title: str
    base_url: str
    author: str
    language: str
    content_dir: Path
    template_dir: Path
    output_dir: Path
    date_format: str
    posts_per_page: int
    feed_items: int
    drafts: bool
    source: str = "site.ini"

    def with_drafts(self, drafts):
        return _replace(self, drafts=drafts)


def _replace(config, **changes):
    values = {name: getattr(config, name) for name in config.__dataclass_fields__}
    values.update(changes)
    return SiteConfig(**values)


class _Reader:
    """Typed access to the merged values, raising :class:`ConfigError`."""

    def __init__(self, source, values):
        self.source = source
        self.values = values

    def raw(self, section, key):
        return self.values[section][key]

    def fail(self, section, key, message):
        raise ConfigError(self.source, message, section, key)

    def text(self, section, key, *, required=False):
        value = self.raw(section, key).strip()
        if required and not value:
            self.fail(section, key, "must not be empty")
        return value

    def positive_int(self, section, key):
        raw = self.raw(section, key)
        try:
            value = int(raw.strip())
        except ValueError:
            value = 0
        if value < 1:
            self.fail(section, key, f"must be a positive integer, got {raw.strip()!r}")
        return value

    def boolean(self, section, key):
        raw = self.raw(section, key).strip().lower()
        if raw in _TRUE:
            return True
        if raw in _FALSE:
            return False
        self.fail(section, key, f"must be yes or no, got {raw!r}")

    def base_url(self, section, key):
        value = self.text(section, key, required=True)
        if not (value.startswith("/") or value.startswith("http://") or value.startswith("https://")):
            self.fail(section, key, f"must start with /, http:// or https://, got {value!r}")
        if not value.endswith("/"):
            self.fail(section, key, f"must end with /, got {value!r}")
        return value

    def directory(self, section, key, root):
        value = self.text(section, key, required=True)
        return (root / value) if not Path(value).is_absolute() else Path(value)


def parse_config(text, source="site.ini", root=Path(".")):
    """Parse ``site.ini`` text into a :class:`SiteConfig`."""
    parser = configparser.ConfigParser(interpolation=None, default_section="__none__")
    parser.optionxform = str
    try:
        parser.read_string(text, source=source)
    except configparser.Error as exc:
        raise ConfigError(source, f"cannot parse: {exc.message.splitlines()[0]}") from exc

    values = {section: dict(keys) for section, keys in DEFAULTS.items()}
    for section in parser.sections():
        if section not in DEFAULTS:
            raise ConfigError(source, "unknown section", section)
        for key, value in parser.items(section):
            if key not in DEFAULTS[section]:
                raise ConfigError(source, "unknown key", section, key)
            values[section][key] = value

    r = _Reader(source, values)
    return SiteConfig(
        title=r.text("site", "title", required=True),
        base_url=r.base_url("site", "base_url"),
        author=r.text("site", "author"),
        language=r.text("site", "language", required=True),
        content_dir=r.directory("build", "content_dir", root),
        template_dir=r.directory("build", "template_dir", root),
        output_dir=r.directory("build", "output_dir", root),
        date_format=r.text("build", "date_format", required=True),
        posts_per_page=r.positive_int("build", "posts_per_page"),
        feed_items=r.positive_int("build", "feed_items"),
        drafts=r.boolean("build", "drafts"),
        source=source,
    )


def load_config(path):
    """Load a ``site.ini`` file. Relative directories resolve against its folder."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(str(path), f"cannot read: {exc.strerror}") from exc
    return parse_config(text, source=path.name, root=path.parent)


def default_config():
    """The configuration used when no ``site.ini`` is given."""
    return parse_config("", source="<defaults>")
