"""Site-relative URLs and output paths."""

from inkwell.text.slug import slugify


def page_path(slug, is_post):
    return f"/posts/{slug}/" if is_post else f"/{slug}/"


def tag_path(tag):
    return f"/tags/{slugify(tag)}/"


def index_path(page_number):
    return "/" if page_number == 1 else f"/page/{page_number}/"


def absolute_url(base_url, path):
    """Join a site-relative path onto ``[site] base_url``."""
    return base_url.rstrip("/") + "/" + str(path).lstrip("/")


def output_file(path):
    """The file a site-relative URL is written to, relative to the output
    directory: ``/posts/x/`` becomes ``posts/x/index.html``."""
    path = path.lstrip("/")
    if not path or path.endswith("/"):
        return path + "index.html"
    return path
