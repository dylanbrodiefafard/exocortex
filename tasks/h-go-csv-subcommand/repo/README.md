# glean

A small command line tool for looking at and reshaping CSV files.

    go build ./cmd/glean
    ./glean headers testdata/cities.csv
    ./glean stats -s population,area_km2 testdata/cities.csv
    ./glean filter -s country -e Spain testdata/cities.csv | ./glean sort -s population -N -r

See [docs/commands.md](docs/commands.md) for every command and the
conventions they share (flags, column selections, errors).

## Layout

- `cmd/glean`: the binary.
- `internal/cli`: argument dispatch, help, error reporting and exit statuses.
- `internal/commands`: one file per subcommand, plus the shared flag and
  input helpers and the command list.
- `internal/csvio`: reading and writing CSV, column selections, delimiters,
  numbers.

## Development

    go test ./...

Standard library only.
