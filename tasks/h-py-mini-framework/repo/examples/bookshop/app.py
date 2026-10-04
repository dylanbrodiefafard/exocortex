"""Routes for the bookshop example."""

from pathlib import Path

from examples.bookshop.data import PAGES, STATIC, Book, seed_books
from wisp import BadRequest, HTMLResponse, JSONResponse, NotFound, Response, Wisp, redirect
from wisp.middleware import CORSMiddleware
from wisp.templating import TemplateLoader

TEMPLATES = TemplateLoader(Path(__file__).parent / "templates")
SORT_KEYS = {"title": lambda b: b.title.lower(), "year": lambda b: (b.year, b.title.lower())}


def create_app(debug: bool = True) -> Wisp:
    app = Wisp(debug=debug, json_errors=True)
    app.add_middleware(CORSMiddleware(allow_origins=["https://shop.example"]))
    books = seed_books()

    def get_book(book_id: int) -> Book:
        if book_id not in books:
            raise NotFound(f"no book with id {book_id}")
        return books[book_id]

    @app.get("/")
    def index(request):
        latest = sorted(books.values(), key=lambda b: -b.year)[:3]
        return TEMPLATES.render("page.html", title="Bookshop", body="Welcome!", books=latest)

    @app.get("/books")
    def list_books(request):
        return [b.summary() for b in sorted(books.values(), key=lambda b: b.id)]

    @app.post("/books")
    def create_book(request):
        form = request.form
        title = (form.get("title") or "").strip()
        author = (form.get("author") or "").strip()
        if not title or not author:
            raise BadRequest("title and author are required")
        try:
            year = int(form.get("year") or "0")
        except ValueError:
            raise BadRequest("year must be an integer") from None
        book = Book(max(books) + 1, title, author, year, form.getall("tag"))
        books[book.id] = book
        return redirect(app.url_for("book_detail", book_id=book.id), status=303)

    @app.get("/books/new")
    def new_book_form(request):
        return HTMLResponse("<form method='post' action='/books'></form>")

    @app.get("/books/<int:book_id>")
    def book_detail(request, book_id):
        return get_book(book_id).to_dict()

    @app.get("/books/<int:book_id>/reviews")
    def book_reviews(request, book_id):
        book = get_book(book_id)
        return {"book_id": book.id, "reviews": book.reviews}

    @app.get("/authors/<name>")
    def author_books(request, name):
        found = [b.summary() for b in books.values() if b.author == name]
        if not found:
            raise NotFound(f"no books by {name}")
        return {"author": name, "books": found}

    @app.get("/tags/<tag>")
    def tag_books(request, tag):
        return {"tag": tag, "books": [b.id for b in sorted(books.values(), key=lambda b: b.id) if tag in b.tags]}

    @app.get("/search")
    def search(request):
        """Search the catalogue.

        Query parameters:
          q      case-insensitive substring of the title or author (optional)
          tag    may be repeated; a book must carry every given tag
          sort   "title" (default) or "year"
          limit  maximum number of results, default 10
        """
        q = request.query.get("q", "").strip().lower()
        tags = request.query.getlist("tag")
        sort = request.query.get("sort", "title")
        if sort not in SORT_KEYS:
            raise BadRequest(f"unknown sort key {sort!r}")
        try:
            limit = int(request.query.get("limit", "10"))
        except ValueError:
            raise BadRequest("limit must be an integer") from None
        hits = [
            b
            for b in books.values()
            if (not q or q in b.title.lower() or q in b.author.lower()) and all(t in b.tags for t in tags)
        ]
        hits.sort(key=SORT_KEYS[sort])
        return JSONResponse(
            {"query": q, "tags": tags, "count": len(hits), "results": [b.summary() for b in hits[:limit]]}
        )

    @app.get("/static/<path:filename>")
    def static(request, filename):
        if filename not in STATIC:
            raise NotFound(f"no static file {filename}")
        content_type, content = STATIC[filename]
        return Response(content, content_type=content_type, headers={"Cache-Control": "max-age=3600"})

    @app.get("/<path:page>")
    def page(request, page):
        if page not in PAGES:
            raise NotFound(f"no page {page}")
        title, body = PAGES[page]
        return TEMPLATES.render("page.html", title=title, body=body, books=[])

    return app
