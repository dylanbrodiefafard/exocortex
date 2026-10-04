package commands

import "example.com/glean/internal/csvio"

var selectCmd = &Command{
	Name:    "select",
	Summary: "Keep only some columns, in the given order",
	Usage:   "glean select -s COLUMNS [-d DELIM] [-n] [FILE]",
	Run:     runSelect,
}

func runSelect(env *Env, args []string) error {
	fs := newFlagSet("select")
	var in inputFlags
	in.register(fs)
	spec := fs.String("s", "", "`COLUMNS` to keep (names, indexes or ranges)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *spec == "" {
		return usageErrorf("-s is required")
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
	writeHeader(w, opts, csvio.Project(t.Header, cols))
	for _, row := range t.Rows {
		w.Write(csvio.Project(row, cols)...)
	}
	return w.Flush()
}
