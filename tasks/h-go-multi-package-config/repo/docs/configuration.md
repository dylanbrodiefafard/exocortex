# Configuration

`tool` reads its configuration in three layers, later layers winning:

1. Built-in defaults.
2. The JSON file given with `--config` (optional). Unknown keys are an error.
   Omitted keys keep their defaults.
3. Environment variables. An empty variable counts as unset. A malformed
   value (for example a non-integer for an integer option) is an error that
   names the variable.

The result is validated; every problem is reported, one per line, and the
tool exits with status 2.

## Options

| Option | Type | Default | Env var | Rule |
|---|---|---|---|---|
| `listen_addr` | string | `:8080` | `TOOL_LISTEN_ADDR` | not empty |
| `log.level` | string | `info` | `TOOL_LOG_LEVEL` | `debug`, `info`, `warn` or `error` |
| `log.format` | string | `text` | `TOOL_LOG_FORMAT` | `text` or `json` |
| `upstream.url` | string | `http://localhost:9000/hooks` | `TOOL_UPSTREAM_URL` | absolute `http`/`https` URL |
| `upstream.timeout_ms` | int | `5000` | `TOOL_UPSTREAM_TIMEOUT_MS` | 100 to 120000; applies to each request |
| `upstream.headers` | object | `{}` | (none) | valid header names |
| `queue.size` | int | `1000` | `TOOL_QUEUE_SIZE` | 1 to 100000 |
| `queue.workers` | int | `4` | `TOOL_QUEUE_WORKERS` | 1 to 64 |

Example:

```json
{
  "log": {"level": "debug"},
  "upstream": {
    "url": "https://hooks.example.com/in",
    "headers": {"Authorization": "Bearer s3cret"}
  },
  "queue": {"workers": 8}
}
```

## Delivery behaviour

Each delivery is POSTed to `upstream.url` with `Content-Type:
application/json`, an `X-Delivery-ID` header and any `upstream.headers`. A
2xx/3xx status is success. A 4xx status means the upstream rejected the
delivery; a 5xx status or a transport error means the upstream failed.

## Printing the effective configuration

`tool --print-config` prints one `key = value` line per option, in this
order: `listen_addr`, `log.*`, `upstream.url`, `upstream.timeout_ms`, one
`upstream.headers.<Name>` line per header (sorted by name; values of
`Authorization`, `Proxy-Authorization` and `X-Api-Key` are shown as
`<redacted>`), then `queue.*`. With the defaults:

```
listen_addr = :8080
log.level = info
log.format = text
upstream.url = http://localhost:9000/hooks
upstream.timeout_ms = 5000
queue.size = 1000
queue.workers = 4
```

`tool --check` validates the configuration and prints `config ok`.
