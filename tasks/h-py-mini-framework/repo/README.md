# wisp

A small web framework core in pure standard-library Python. wisp maps
`Request` objects to `Response` objects; it has no server of its own; use
`wisp.testing.TestClient` (or wrap `Wisp.handle` in your server of choice).

```python
from wisp import Wisp

app = Wisp()

@app.get("/hello/<name>")
def hello(request, name):
    return {"hello": name}
```

Layout:

- `wisp/routing/`: URL patterns, converters, the router (see `docs/routing.md`)
- `wisp/request/`: `Request`, headers, cookies, form bodies
- `wisp/response/`: `Response`, `JSONResponse`, `HTMLResponse`, `redirect`
- `wisp/middleware/`: error handling, CORS, timing
- `wisp/templating/`: a tiny template language
- `wisp/utils/`: encoding helpers, `MultiDict`, text helpers
- `examples/bookshop/`: an example application

Run the tests with:

```
python3 -m unittest discover -q -s tests -t .
```
