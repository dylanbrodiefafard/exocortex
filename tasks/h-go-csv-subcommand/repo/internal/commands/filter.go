package commands

import (
	"regexp"

	"example.com/glean/internal/csvio"
)

var filterCmd = &Command{
	Name:    "filter",
	Summary: "Keep rows where a column matches a regular expression",
	Usage:   "glean filter -e REGEXP [-s COLUMNS] [-v] [-d DELIM] [-n] [FILE]",
	Run:     runFilter,
}

func runFilter(env *Env, args []string) error {
	fs := newFlagSet("filter")
	var in inputFlags
	in.register(fs)
	pattern := fs.String("e", "", "`REGEXP` to match (Go syntax)")
	spec := fs.String("s", "", "`COLUMNS` to search (default: all)")
	invert := fs.Bool("v", false, "keep rows that do not match")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *pattern == "" {
		return usageErrorf("-e is required")
	}
	re, err := regexp.Compile(*pattern)
	if err != nil {
		return usageErrorf("-e: %v", err)
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
	writeHeader(w, opts, t.Header)
	for _, row := range t.Rows {
		matched := false
		for _, c := range cols {
			if re.MatchString(row[c]) {
				matched = true
				break
			}
		}
		if matched != *invert {
			w.Write(row...)
		}
	}
	return w.Flush()
}
