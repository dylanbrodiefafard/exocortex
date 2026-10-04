"""Errors reported to the user.

Every error the user can cause carries enough location information to be
fixed without a traceback; the CLI prints ``str(error)`` and exits with
status 1.
"""


class InkwellError(Exception):
    """Base class for errors reported to the user."""


class ConfigError(InkwellError):
    """A problem in ``site.ini``: ``<file>: [<section>] <key>: <message>``."""

    def __init__(self, source, message, section=None, key=None):
        self.source = source
        self.section = section
        self.key = key
        self.message = message
        where = source
        if section is not None:
            where += f": [{section}]"
            if key is not None:
                where += f" {key}"
        super().__init__(f"{where}: {message}")


class ContentError(InkwellError):
    """A problem in a content file: ``<file>:<line>: <message>``."""

    def __init__(self, source, line, message):
        self.source = source
        self.line = line
        self.message = message
        super().__init__(f"{source}:{line}: {message}")


class TemplateError(InkwellError):
    """A problem in a template: ``<template>:<line>: <message>``."""

    def __init__(self, template, line, message):
        self.template = template
        self.line = line
        self.message = message
        super().__init__(f"{template}:{line}: {message}")


class FilterError(InkwellError):
    """Raised by a filter. The template engine re-raises it as a
    :class:`TemplateError` carrying the template name and line."""
