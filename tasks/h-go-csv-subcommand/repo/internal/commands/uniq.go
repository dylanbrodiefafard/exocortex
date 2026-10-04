package commands

import (
	"strings"

	"example.com/glean/internal/csvio"
)

var uniqCmd = &Command{
	Name:    "uniq",
	Summary: "Drop rows that repeat earlier rows",
	Usage:   "glean uniq [-s COLUMNS] [-i] [-d DELIM] [-n] [FILE]",
	Run:     runUniq,
}

func runUniq(env *Env, args []string) error {
	fs := newFlagSet("uniq")
	var in inputFlags
	in.register(fs)
	spec := fs.String("s", "", "`COLUMNS` that make a row a repeat (default: all)")
	fold := fs.Bool("i", false, "compare case-insensitively")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	t, opts, err := readTable(env, &in, fs.Args())
	if err != nil {
		return err
	}
	cols, err := selectColumns(t, *spec)
	if err != nil {
		return err
	}
	seen := make(map[string]bool)
	w := csvio.NewWriter(env.Stdout, opts.Comma)
	writeHeader(w, opts, t.Header)
	for _, row := range t.Rows {
		k := rowKey(csvio.Project(row, cols), *fold)
		if seen[k] {
			continue
		}
		seen[k] = true
		w.Write(row...)
	}
	return w.Flush()
}

// rowKey joins cells into a map key that cannot collide across different
// cell boundaries.
func rowKey(cells []string, fold bool) string {
	var b strings.Builder
	for _, c := range cells {
		if fold {
			c = strings.ToLower(c)
		}
		b.WriteString(c)
		b.WriteByte(0)
	}
	return b.String()
}
