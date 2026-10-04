"""Rendering every page of a site into the output directory."""

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from inkwell.content import load_pages
from inkwell.site.urls import absolute_url, index_path, output_file, tag_path
from inkwell.template import Environment


@dataclass
class BuildResult:
    written: list = field(default_factory=list)

    def add(self, path):
        self.written.append(path)


@dataclass(frozen=True)
class TagInfo:
    name: str
    url: str
    posts: list


def collect_tags(posts):
    """Tags in name order, each with its posts (newest first)."""
    tags = {}
    for post in posts:
        for tag in post.tags:
            tags.setdefault(tag, []).append(post)
    return [TagInfo(name, tag_path(name), tags[name]) for name in sorted(tags, key=str.lower)]


def paginate(items, per_page):
    """Split ``items`` into pages of ``per_page``; always at least one page."""
    pages = [items[i:i + per_page] for i in range(0, len(items), per_page)]
    return pages or [[]]


class Builder:
    def __init__(self, config, env=None):
        self.config = config
        self.env = env if env is not None else Environment(config)
        self.result = BuildResult()

    def build(self, clean=True):
        output = Path(self.config.output_dir)
        if clean and output.exists():
            shutil.rmtree(output)
        pages = load_pages(self.config)
        posts = [p for p in pages if p.is_post]
        tags = collect_tags(posts)
        base = {"site": self.config, "posts": posts, "tags": tags}
        for page in pages:
            self.write(page.url, self.env.render(page.template, base, page=page))
        self.write_index(posts, base)
        for tag in tags:
            self.write(tag.url, self.env.render("tag.html", base, tag=tag, page=None))
        self.write("/feed.xml", self.feed(posts))
        return self.result

    def write_index(self, posts, base):
        chunks = paginate(posts, self.config.posts_per_page)
        for number, chunk in enumerate(chunks, start=1):
            pagination = {
                "number": number,
                "total": len(chunks),
                "previous": index_path(number - 1) if number > 1 else None,
                "next": index_path(number + 1) if number < len(chunks) else None,
            }
            html = self.env.render("index.html", base, page=None, entries=chunk, pagination=pagination)
            self.write(index_path(number), html)

    def feed(self, posts):
        cfg = self.config
        entries = []
        for post in posts[: cfg.feed_items]:
            url = absolute_url(cfg.base_url, post.url)
            entries.append(
                "  <entry>\n"
                f"    <title>{xml_escape(post.title)}</title>\n"
                f"    <link href=\"{xml_escape(url)}\"/>\n"
                f"    <id>{xml_escape(url)}</id>\n"
                f"    <updated>{post.date.isoformat()}T00:00:00Z</updated>\n"
                "  </entry>\n"
            )
        updated = posts[0].date.isoformat() if posts else "1970-01-01"
        return (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<feed xmlns="http://www.w3.org/2005/Atom">\n'
            f"  <title>{xml_escape(cfg.title)}</title>\n"
            f"  <link href=\"{xml_escape(cfg.base_url)}\"/>\n"
            f"  <updated>{updated}T00:00:00Z</updated>\n"
            + "".join(entries)
            + "</feed>\n"
        )

    def write(self, url, text):
        path = Path(self.config.output_dir) / output_file(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        self.result.add(path)


def build_site(config, clean=True):
    return Builder(config).build(clean=clean)
