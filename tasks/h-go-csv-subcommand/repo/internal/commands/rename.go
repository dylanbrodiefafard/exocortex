package commands

import (
	"strings"

	"example.com/glean/internal/csvio"
)

var renameCmd = &Command{
	Name:    "rename",
	Summary: "Rename columns",
	Usage:   "glean rename -r OLD=NEW[,OLD=NEW...] [-d DELIM] [FILE]",
	Run:     runRename,
}

func runRename(env *Env, args []string) error {
	fs := newFlagSet("rename")
	var in inputFlags
	in.register(fs)
	pairs := fs.String("r", "", "comma-separated `OLD=NEW` pairs; OLD is a column name or index")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *pairs == "" {
		return usageErrorf("-r is required")
	}
	t, opts, err := readTable(env, &in, fs.Args())
	if err != nil {
		return err
	}
	if opts.NoHeader {
		return usageErrorf("-n makes no sense here: there is no header to rename")
	}
	header := append([]string(nil), t.Header...)
	for _, pair := range strings.Split(*pairs, ",") {
		oldName, newName, ok := strings.Cut(pair, "=")
		if !ok || strings.TrimSpace(newName) == "" {
			return usageErrorf("-r: expected OLD=NEW, got %q", pair)
		}
		cols, err := selectColumns(t, oldName)
		if err != nil {
			return err
		}
		if len(cols) != 1 {
			return usageErrorf("-r: %q selects %d columns, want 1", oldName, len(cols))
		}
		header[cols[0]] = strings.TrimSpace(newName)
	}
	w := csvio.NewWriter(env.Stdout, opts.Comma)
	w.Write(header...)
	for _, row := range t.Rows {
		w.Write(row...)
	}
	return w.Flush()
}
