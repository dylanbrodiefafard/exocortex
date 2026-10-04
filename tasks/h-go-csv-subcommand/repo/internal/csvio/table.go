// Package csvio reads and writes the CSV tables glean works on.
package csvio

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
)

// Options control how input is read.
type Options struct {
	// Comma is the field delimiter.
	Comma rune
	// NoHeader means the first row is data. Columns are then named by their
	// 1-based index ("1", "2", ...).
	NoHeader bool
}

// Table is a whole CSV input held in memory.
type Table struct {
	Header []string
	Rows   [][]string
}

// InputError is a problem reading or parsing an input. Its message is
// "<name>: line <n>: <problem>" when a line is known.
type InputError struct {
	Name string
	Line int
	Err  error
}

func (e *InputError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("%s: line %d: %v", e.Name, e.Line, e.Err)
	}
	return fmt.Sprintf("%s: %v", e.Name, e.Err)
}

func (e *InputError) Unwrap() error { return e.Err }

// ErrEmpty is returned for an input without a header row.
var ErrEmpty = errors.New("input is empty")

// Read parses all of r. name identifies the input in errors.
func Read(r io.Reader, name string, opts Options) (*Table, error) {
	cr := csv.NewReader(r)
	if opts.Comma != 0 {
		cr.Comma = opts.Comma
	}
	cr.FieldsPerRecord = 0
	cr.ReuseRecord = false
	records, err := cr.ReadAll()
	if err != nil {
		var pe *csv.ParseError
		if errors.As(err, &pe) {
			return nil, &InputError{Name: name, Line: pe.Line, Err: pe.Err}
		}
		return nil, &InputError{Name: name, Err: err}
	}
	t := &Table{}
	if opts.NoHeader {
		if len(records) == 0 {
			return t, nil
		}
		t.Header = IndexHeader(len(records[0]))
		t.Rows = records
		return t, nil
	}
	if len(records) == 0 {
		return nil, &InputError{Name: name, Err: ErrEmpty}
	}
	t.Header = records[0]
	t.Rows = records[1:]
	return t, nil
}

// IndexHeader returns the column names used for headerless input.
func IndexHeader(n int) []string {
	h := make([]string, n)
	for i := range h {
		h[i] = strconv.Itoa(i + 1)
	}
	return h
}

// Column returns the values of column i in row order.
func (t *Table) Column(i int) []string {
	out := make([]string, len(t.Rows))
	for r, row := range t.Rows {
		out[r] = row[i]
	}
	return out
}

// Project returns the given columns of a row, in the given order.
func Project(row []string, cols []int) []string {
	out := make([]string, len(cols))
	for i, c := range cols {
		out[i] = row[c]
	}
	return out
}
