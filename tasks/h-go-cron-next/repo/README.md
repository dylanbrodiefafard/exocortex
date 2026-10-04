# cron

Parses five-field cron expressions (`minute hour day-of-month month day-of-week`)
and computes upcoming fire times. No dependencies beyond the standard library.

```go
s, err := cron.Parse("30 9 * * MON-FRI")
next := s.Next(time.Now())
```

Run the tests with `go test ./...`.
