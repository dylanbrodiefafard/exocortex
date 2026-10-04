"""Loading content files from the content directory."""

import datetime
from pathlib import Path

from inkwell.content import markup
from inkwell.content.frontmatter import split_front_matter
from inkwell.content.page import Page
from inkwell.errors import ContentError
from inkwell.site.urls import page_path
from inkwell.text.slug import slugify

CONTENT_SUFFIX = ".md"
_KNOWN = {"title", "date", "tags", "draft", "slug", "template"}


def load_page(path, root, config=None):
    path = Path(path)
    source = path.relative_to(root).as_posix() if root else path.name
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise ContentError(source, 1, "file is not valid UTF-8") from None
    return parse_page(text, source)


def parse_page(text, source):
    meta, body, _ = split_front_matter(text, source)
    title = meta.get("title")
    if not isinstance(title, str) or not title:
        raise ContentError(source, 1, "front matter must set a title")
    date = meta.get("date")
    if date is not None and not isinstance(date, datetime.date):
        raise ContentError(source, 1, f"date must be YYYY-MM-DD, got {date!r}")
    tags = meta.get("tags", [])
    if isinstance(tags, str):
        tags = [tags]
    stem = Path(source).stem
    slug = meta.get("slug") or slugify(stem)
    return Page(
        source=source,
        slug=slug,
        title=title,
        date=date,
        content=markup.render(body),
        url=page_path(slug, is_post=date is not None),
        template=meta.get("template", "post.html" if date is not None else "page.html"),
        tags=[str(t) for t in tags],
        draft=bool(meta.get("draft", False)),
        meta={k: v for k, v in meta.items() if k not in _KNOWN},
    )


def load_pages(config):
    """All pages under ``config.content_dir``: posts newest first, then
    other pages by title. Drafts are skipped unless ``config.drafts``."""
    root = Path(config.content_dir)
    pages = []
    for path in sorted(root.rglob("*" + CONTENT_SUFFIX)):
        page = load_page(path, root)
        if page.draft and not config.drafts:
            continue
        pages.append(page)
    posts = sorted((p for p in pages if p.is_post), key=lambda p: (p.date, p.title), reverse=True)
    others = sorted((p for p in pages if not p.is_post), key=lambda p: p.title)
    _check_unique_urls(posts + others)
    return posts + others


def _check_unique_urls(pages):
    seen = {}
    for page in pages:
        if page.url in seen:
            raise ContentError(page.source, 1, f"URL {page.url} is also used by {seen[page.url]}")
        seen[page.url] = page.source
