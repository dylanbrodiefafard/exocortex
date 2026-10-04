"""Path parameter converters.

A converter validates one captured value and turns it into a Python object.
``priority`` orders routes when several match the same path: lower values
are more specific and win (static segments always beat any converter).
"""

import re


class Converter:
    name = "str"
    priority = 30
    regex = re.compile(r"[^/]+")
    #: Whether the converter may consume several path segments.
    multi_segment = False

    def accepts(self, value: str) -> bool:
        return bool(self.regex.fullmatch(value))

    def to_python(self, value: str):
        return value

    def to_url(self, value) -> str:
        return str(value)


class StrConverter(Converter):
    pass


class IntConverter(Converter):
    name = "int"
    priority = 10
    regex = re.compile(r"[0-9]+")

    def to_python(self, value: str) -> int:
        return int(value)


class SlugConverter(Converter):
    name = "slug"
    priority = 20
    regex = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


class PathConverter(Converter):
    name = "path"
    priority = 40
    regex = re.compile(r".+", re.DOTALL)
    multi_segment = True


CONVERTERS: dict[str, Converter] = {
    c.name: c for c in (StrConverter(), IntConverter(), SlugConverter(), PathConverter())
}
