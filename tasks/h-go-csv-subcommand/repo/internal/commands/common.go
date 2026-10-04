package commands

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"example.com/glean/internal/csvio"
)

// UsageError reports a wrong command line: bad flags, bad flag values,
// too many arguments or an invalid column selection.
type UsageError struct{ Msg string }

func (e *UsageError) Error() string { return e.Msg }

func usageErrorf(format string, args ...any) error {
	return &UsageError{Msg: fmt.Sprintf(format, args...)}
}

// newFlagSet returns a flag set that reports errors instead of exiting and
// prints nothing on its own.
func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parseFlags parses args, turning flag errors into *UsageError. flag.ErrHelp
// is passed through so the CLI can print help.
func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return &UsageError{Msg: err.Error()}
	}
	return nil
}

// inputFlags are the flags shared by every command that reads a table.
type inputFlags struct {
	delimiter string
	noHeader  bool
}

func (f *inputFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&f.delimiter, "d", ",", "field `DELIM`iter: a character, or tab, comma, semicolon, pipe")
	fs.BoolVar(&f.noHeader, "n", false, "the input has no header row; columns are named 1, 2, ...")
}

func (f *inputFlags) options() (csvio.Options, error) {
	comma, err := csvio.ParseDelimiter(f.delimiter)
	if err != nil {
		return csvio.Options{}, &UsageError{Msg: "-d: " + err.Error()}
	}
	return csvio.Options{Comma: comma, NoHeader: f.noHeader}, nil
}

// readTable reads the table named by the positional arguments: none or "-"
// for standard input, or one file name.
func readTable(env *Env, f *inputFlags, args []string) (*csvio.Table, csvio.Options, error) {
	opts, err := f.options()
	if err != nil {
		return nil, opts, err
	}
	if len(args) > 1 {
		return nil, opts, usageErrorf("too many arguments: %s", strings.Join(args[1:], " "))
	}
	if len(args) == 0 || args[0] == "-" {
		t, err := csvio.Read(env.Stdin, "stdin", opts)
		return t, opts, err
	}
	file, err := os.Open(args[0])
	if err != nil {
		return nil, opts, err
	}
	defer file.Close()
	t, err := csvio.Read(file, args[0], opts)
	return t, opts, err
}

// selectColumns resolves a -s value against the table's header. Problems
// with the selection are usage errors.
func selectColumns(t *csvio.Table, spec string) ([]int, error) {
	cols, err := csvio.ResolveColumns(t.Header, spec)
	if err != nil {
		return nil, &UsageError{Msg: err.Error()}
	}
	return cols, nil
}

// checkNonNegative validates an integer flag that must be >= 0.
func checkNonNegative(flagName string, v int) error {
	if v < 0 {
		return usageErrorf("-%s must be >= 0, got %d", flagName, v)
	}
	return nil
}

// writeHeader writes the header row unless the input had none.
func writeHeader(w *csvio.Writer, opts csvio.Options, header []string) {
	if !opts.NoHeader {
		w.Write(header...)
	}
}
