package commands

import (
	"os"

	"example.com/glean/internal/csvio"
)

var joinCmd = &Command{
	Name:    "join",
	Summary: "Join two tables on key columns",
	Usage:   "glean join -k COLUMNS [-K COLUMNS] [-left] [-d DELIM] [-n] LEFT RIGHT",
	Run:     runJoin,
}

func runJoin(env *Env, args []string) error {
	fs := newFlagSet("join")
	var in inputFlags
	in.register(fs)
	leftSpec := fs.String("k", "", "key `COLUMNS` in LEFT")
	rightSpec := fs.String("K", "", "key `COLUMNS` in RIGHT (default: same as -k)")
	keepLeft := fs.Bool("left", false, "also write LEFT rows without a match, with empty RIGHT cells")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *leftSpec == "" {
		return usageErrorf("-k is required")
	}
	if *rightSpec == "" {
		*rightSpec = *leftSpec
	}
	if fs.NArg() != 2 {
		return usageErrorf("expected two files, got %d", fs.NArg())
	}
	opts, err := in.options()
	if err != nil {
		return err
	}
	left, err := readFile(env, fs.Arg(0), opts)
	if err != nil {
		return err
	}
	right, err := readFile(env, fs.Arg(1), opts)
	if err != nil {
		return err
	}
	lk, err := selectColumns(left, *leftSpec)
	if err != nil {
		return err
	}
	rk, err := selectColumns(right, *rightSpec)
	if err != nil {
		return err
	}
	if len(lk) != len(rk) {
		return usageErrorf("-k selects %d columns but -K selects %d", len(lk), len(rk))
	}

	index := make(map[string][]int)
	for i, row := range right.Rows {
		k := rowKey(csvio.Project(row, rk), false)
		index[k] = append(index[k], i)
	}
	rest := otherColumns(len(right.Header), rk)

	w := csvio.NewWriter(env.Stdout, opts.Comma)
	writeHeader(w, opts, append(append([]string(nil), left.Header...), csvio.Project(right.Header, rest)...))
	blank := make([]string, len(rest))
	for _, row := range left.Rows {
		matches := index[rowKey(csvio.Project(row, lk), false)]
		if len(matches) == 0 && *keepLeft {
			w.Write(append(append([]string(nil), row...), blank...)...)
		}
		for _, m := range matches {
			w.Write(append(append([]string(nil), row...), csvio.Project(right.Rows[m], rest)...)...)
		}
	}
	return w.Flush()
}

// readFile reads one named input; "-" is standard input.
func readFile(env *Env, name string, opts csvio.Options) (*csvio.Table, error) {
	if name == "-" {
		return csvio.Read(env.Stdin, "stdin", opts)
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return csvio.Read(f, name, opts)
}

// otherColumns returns the indexes in [0, n) that are not in skip.
func otherColumns(n int, skip []int) []int {
	drop := make(map[int]bool, len(skip))
	for _, c := range skip {
		drop[c] = true
	}
	var out []int
	for i := 0; i < n; i++ {
		if !drop[i] {
			out = append(out, i)
		}
	}
	return out
}
