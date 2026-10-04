package commands

import (
	"fmt"
	"text/tabwriter"
)

var headersCmd = &Command{
	Name:    "headers",
	Summary: "Print the column names with their indexes",
	Usage:   "glean headers [-d DELIM] [FILE]",
	Run:     runHeaders,
}

func runHeaders(env *Env, args []string) error {
	fs := newFlagSet("headers")
	var in inputFlags
	in.register(fs)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	t, _, err := readTable(env, &in, fs.Args())
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(env.Stdout, 0, 4, 2, ' ', 0)
	for i, name := range t.Header {
		fmt.Fprintf(tw, "%d\t%s\n", i+1, name)
	}
	return tw.Flush()
}
