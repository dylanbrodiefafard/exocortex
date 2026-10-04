# hookrelay

`tool` forwards webhook deliveries (JSON lines on stdin) to an upstream HTTP
endpoint, with a bounded queue and concurrent workers.

```
go run ./cmd/tool --config relay.json < deliveries.jsonl
go run ./cmd/tool --print-config
```

Packages:

- `internal/config`: defaults, JSON + environment loading, validation
- `internal/app`: the queue/worker app and the upstream client
- `internal/render`: human-readable config output for `--print-config`
- `internal/logging`: leveled text/JSON logger
- `internal/queue`: bounded FIFO
- `cmd/tool`: the command-line entry point

Configuration is documented in `docs/configuration.md`. Run the tests with
`go test ./...`.
