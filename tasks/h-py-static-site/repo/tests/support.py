"""Shared helpers for the tests."""

from inkwell.config import parse_config
from inkwell.template import DictLoader, Environment


def make_env(templates=None, config_text=""):
    config = parse_config(config_text)
    return Environment(config, DictLoader(templates or {}))


def render(source, config_text="", **variables):
    """Render a template string named ``page.html``."""
    env = make_env({"page.html": source}, config_text)
    return env.render("page.html", variables)
