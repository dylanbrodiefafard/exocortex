// Package cli is glean's command line front end: it picks the subcommand,
// prints help and turns errors into messages and exit statuses.
package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"

	"example.com/glean/internal/commands"
)

// Version is printed by "glean version".
const Version = "1.4.0"

// Exit statuses.
const (
	ExitOK      = 0
	ExitFailure = 1
	ExitUsage   = 2
)

// Main runs glean with args (without the program name) and returns the exit
// status.
func Main(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printOverview(stderr)
		return ExitUsage
	}
	switch args[0] {
	case "help", "-h", "-help", "--help":
		return help(args[1:], stdout, stderr)
	case "version", "--version":
		fmt.Fprintf(stdout, "glean %s\n", Version)
		return ExitOK
	}
	cmd := commands.Lookup(args[0])
	if cmd == nil {
		fmt.Fprintf(stderr, "glean: unknown command %q\nRun 'glean help' for the list of commands.\n", args[0])
		return ExitUsage
	}
	env := &commands.Env{Stdin: stdin, Stdout: stdout, Stderr: stderr}
	return report(cmd, cmd.Run(env, args[1:]), stdout, stderr)
}

// report prints err, if any, and returns the exit status for it.
func report(cmd *commands.Command, err error, stdout, stderr io.Writer) int {
	if err == nil {
		return ExitOK
	}
	if errors.Is(err, flag.ErrHelp) {
		printCommandHelp(stdout, cmd)
		return ExitOK
	}
	var usage *commands.UsageError
	if errors.As(err, &usage) {
		fmt.Fprintf(stderr, "glean %s: %s\nusage: %s\n", cmd.Name, usage.Msg, cmd.Usage)
		return ExitUsage
	}
	fmt.Fprintf(stderr, "glean %s: %v\n", cmd.Name, err)
	return ExitFailure
}

func help(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printOverview(stdout)
		return ExitOK
	}
	cmd := commands.Lookup(args[0])
	if cmd == nil {
		fmt.Fprintf(stderr, "glean help: unknown command %q\n", args[0])
		return ExitUsage
	}
	printCommandHelp(stdout, cmd)
	return ExitOK
}

func printOverview(w io.Writer) {
	fmt.Fprint(w, "glean inspects and reshapes CSV files.\n\n")
	fmt.Fprint(w, "usage: glean <command> [options] [FILE]\n\ncommands:\n")
	for _, c := range commands.All() {
		fmt.Fprintf(w, "  %-10s %s\n", c.Name, c.Summary)
	}
	fmt.Fprint(w, "\nRun 'glean help <command>' for details. FILE defaults to standard input.\n")
}

func printCommandHelp(w io.Writer, cmd *commands.Command) {
	fmt.Fprintf(w, "usage: %s\n\n%s.\n", cmd.Usage, cmd.Summary)
}
