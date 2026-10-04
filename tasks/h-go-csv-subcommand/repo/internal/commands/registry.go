// Package commands implements glean's subcommands.
package commands

import (
	"io"
	"sort"
)

// Env is what a command may touch.
type Env struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// Command is one glean subcommand.
type Command struct {
	// Name is the word typed after "glean".
	Name string
	// Summary is the one-line description shown by "glean help".
	Summary string
	// Usage is the synopsis printed after "usage: ".
	Usage string
	// Run executes the command. args excludes the command name. A
	// *UsageError means the command line was wrong (exit status 2); any
	// other error means the command failed (exit status 1).
	Run func(env *Env, args []string) error
}

// builtins lists every subcommand.
var builtins = []*Command{
	headersCmd,
	countCmd,
	selectCmd,
	headCmd,
	sortCmd,
	filterCmd,
	statsCmd,
	uniqCmd,
	renameCmd,
	convertCmd,
	joinCmd,
}

// All returns every command sorted by name.
func All() []*Command {
	out := append([]*Command(nil), builtins...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Lookup returns the command called name, or nil.
func Lookup(name string) *Command {
	for _, c := range builtins {
		if c.Name == name {
			return c
		}
	}
	return nil
}
