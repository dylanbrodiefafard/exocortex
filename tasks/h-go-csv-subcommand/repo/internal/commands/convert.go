package commands

import "example.com/glean/internal/csvio"

var convertCmd = &Command{
	Name:    "convert",
	Summary: "Rewrite the table with a different delimiter",
	Usage:   "glean convert -o DELIM [-d DELIM] [-n] [FILE]",
	Run:     runConvert,
}

func runConvert(env *Env, args []string) error {
	fs := newFlagSet("convert")
	var in inputFlags
	in.register(fs)
	outDelim := fs.String("o", "", "output delimiter (`DELIM`), same forms as -d")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *outDelim == "" {
		return usageErrorf("-o is required")
	}
	comma, err := csvio.ParseDelimiter(*outDelim)
	if err != nil {
		return usageErrorf("-o: %v", err)
	}
	t, opts, err := readTable(env, &in, fs.Args())
	if err != nil {
		return err
	}
	w := csvio.NewWriter(env.Stdout, comma)
	writeHeader(w, opts, t.Header)
	for _, row := range t.Rows {
		w.Write(row...)
	}
	return w.Flush()
}
