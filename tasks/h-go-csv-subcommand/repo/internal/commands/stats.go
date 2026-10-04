package commands

import (
	"math"
	"strconv"

	"example.com/glean/internal/csvio"
)

var statsCmd = &Command{
	Name:    "stats",
	Summary: "Summarize each column: counts, and min/max/mean of numbers",
	Usage:   "glean stats [-s COLUMNS] [-d DELIM] [-n] [FILE]",
	Run:     runStats,
}

// statsHeader is the header of the stats output.
var statsHeader = []string{"field", "rows", "empty", "numeric", "min", "max", "mean"}

func runStats(env *Env, args []string) error {
	fs := newFlagSet("stats")
	var in inputFlags
	in.register(fs)
	spec := fs.String("s", "", "`COLUMNS` to summarize (default: all)")
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
	w := csvio.NewWriter(env.Stdout, opts.Comma)
	w.Write(statsHeader...)
	for _, c := range cols {
		s := summarize(t.Column(c))
		row := []string{t.Header[c], strconv.Itoa(s.rows), strconv.Itoa(s.empty), strconv.Itoa(s.numeric), "", "", ""}
		if s.numeric > 0 {
			row[4] = csvio.FormatNumber(s.min)
			row[5] = csvio.FormatNumber(s.max)
			row[6] = csvio.FormatNumber(math.Round(s.sum/float64(s.numeric)*1e6) / 1e6)
		}
		w.Write(row...)
	}
	return w.Flush()
}

type summary struct {
	rows, empty, numeric int
	min, max, sum        float64
}

func summarize(values []string) summary {
	s := summary{rows: len(values), min: math.Inf(1), max: math.Inf(-1)}
	for _, v := range values {
		if v == "" {
			s.empty++
			continue
		}
		f, ok := csvio.ParseNumber(v)
		if !ok {
			continue
		}
		s.numeric++
		s.sum += f
		s.min = math.Min(s.min, f)
		s.max = math.Max(s.max, f)
	}
	return s
}
