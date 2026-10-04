"""A rendered content page."""

import datetime
from dataclasses import dataclass, field

from inkwell.text.html import Markup


@dataclass
class Page:
    source: str
    slug: str
    title: str
    date: datetime.date | None
    content: Markup
    url: str
    template: str = "post.html"
    tags: list = field(default_factory=list)
    draft: bool = False
    meta: dict = field(default_factory=dict)

    @property
    def is_post(self):
        return self.date is not None

    def __getitem__(self, key):
        if key in self.meta:
            return self.meta[key]
        raise KeyError(key)
