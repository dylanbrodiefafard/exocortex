package commands

import (
	"sort"

	"example.com/glean/internal/csvio"
)

var sortCmd = &Command{
	Name:    "sort",
	Summary: "Sort rows by one or more columns",
	Usage:   "glean sort [-s COLUMNS] [-N] [-r] [-d DELIM] [-n] [FILE]",
	Run:     runSort,
}

func runSort(env *Env, args []string) error {
	fs := newFlagSet("sort")
	var in inputFlags
	in.register(fs)
	spec := fs.String("s", "", "`COLUMNS` to sort by, most significant first (default: all)")
	numeric := fs.Bool("N", false, "compare as numbers; non-numbers sort after numbers")
	reverse := fs.Bool("r", false, "reverse the order")
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
	less := func(a, b []string) bool {
		for _, c := range cols {
			if d := compareCells(a[c], b[c], *numeric); d != 0 {
				return d < 0
			}
		}
		return false
	}
	sort.SliceStable(t.Rows, func(i, j int) bool {
		if *reverse {
			return less(t.Rows[j], t.Rows[i])
		}
		return less(t.Rows[i], t.Rows[j])
	})
	w := csvio.NewWriter(env.Stdout, opts.Comma)
	writeHeader(w, opts, t.Header)
	for _, row := range t.Rows {
		w.Write(row...)
	}
	return w.Flush()
}

// compareCells orders two cells as strings, or as numbers when numeric is
// set (numbers first, then the rest as strings).
func compareCells(a, b string, numeric bool) int {
	if numeric {
		fa, oka := csvio.ParseNumber(a)
		fb, okb := csvio.ParseNumber(b)
		switch {
		case oka && okb:
			if fa < fb {
				return -1
			}
			if fa > fb {
				return 1
			}
			return 0
		case oka:
			return -1
		case okb:
			return 1
		}
	}
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
