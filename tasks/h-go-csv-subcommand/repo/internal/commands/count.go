package commands

import "fmt"

var countCmd = &Command{
	Name:    "count",
	Summary: "Print the number of rows",
	Usage:   "glean count [-d DELIM] [-n] [FILE]",
	Run:     runCount,
}

func runCount(env *Env, args []string) error {
	fs := newFlagSet("count")
	var in inputFlags
	in.register(fs)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	t, _, err := readTable(env, &in, fs.Args())
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(env.Stdout, len(t.Rows))
	return err
}
