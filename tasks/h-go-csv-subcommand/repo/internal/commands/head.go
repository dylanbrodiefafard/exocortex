package commands

import "example.com/glean/internal/csvio"

var headCmd = &Command{
	Name:    "head",
	Summary: "Print the first rows",
	Usage:   "glean head [-l LIMIT] [-d DELIM] [-n] [FILE]",
	Run:     runHead,
}

func runHead(env *Env, args []string) error {
	fs := newFlagSet("head")
	var in inputFlags
	in.register(fs)
	limit := fs.Int("l", 10, "number of rows to print (`LIMIT`); 0 prints only the header")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if err := checkNonNegative("l", *limit); err != nil {
		return err
	}
	t, opts, err := readTable(env, &in, fs.Args())
	if err != nil {
		return err
	}
	w := csvio.NewWriter(env.Stdout, opts.Comma)
	writeHeader(w, opts, t.Header)
	for i, row := range t.Rows {
		if i >= *limit {
			break
		}
		w.Write(row...)
	}
	return w.Flush()
}
