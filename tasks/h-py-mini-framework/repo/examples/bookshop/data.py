"""In-memory catalogue used by the example app."""

from dataclasses import dataclass, field


@dataclass
class Book:
    id: int
    title: str
    author: str
    year: int
    tags: list[str] = field(default_factory=list)
    reviews: list[dict] = field(default_factory=list)

    def summary(self) -> dict:
        return {"id": self.id, "title": self.title, "author": self.author, "year": self.year}

    def to_dict(self) -> dict:
        return {**self.summary(), "tags": list(self.tags)}


def seed_books() -> dict[int, Book]:
    books = [
        Book(1, "Dune", "Frank Herbert", 1965, ["sf", "classic"], [{"stars": 5, "text": "Spice!"}]),
        Book(2, "The Left Hand of Darkness", "Ursula K. Le Guin", 1969, ["sf", "classic"]),
        Book(3, "A Wizard of Earthsea", "Ursula K. Le Guin", 1968, ["fantasy", "classic"]),
        Book(4, "Les Misérables", "Victor Hugo", 1862, ["classic", "historical"]),
        Book(5, "Les Faux-monnayeurs", "André Gide", 1925, ["classic"]),
        Book(6, "Neuromancer", "William Gibson", 1984, ["sf", "cyberpunk"]),
        Book(7, "The C++ Programming Language", "Bjarne Stroustrup", 1985, ["programming", "c++"]),
        Book(8, "Let There Be Rock", "Susan Masino", 2006, ["music", "ac/dc"]),
        Book(
            42,
            "The Hitchhiker's Guide to the Galaxy",
            "Douglas Adams",
            1979,
            ["sf", "humor"],
            [{"stars": 5, "text": "Don't panic."}, {"stars": 4, "text": "Towel advice is solid."}],
        ),
    ]
    return {b.id: b for b in books}


PAGES = {
    "about": ("About us", "We sell books. Mostly old ones."),
    "help": ("Help", "Browse by author, tag or search."),
    "help/shipping": ("Shipping", "We ship anywhere a bicycle can reach."),
}

STATIC = {
    "css/site.css": ("text/css", "body { font-family: serif; }"),
    "img/logo.svg": ("image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>"),
}
