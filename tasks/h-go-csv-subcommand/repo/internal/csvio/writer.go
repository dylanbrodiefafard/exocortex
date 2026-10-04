package csvio

import (
	"encoding/csv"
	"io"
)

// Writer writes CSV records with the same delimiter as the input.
type Writer struct {
	w   *csv.Writer
	err error
}

// NewWriter returns a Writer using comma as the delimiter.
func NewWriter(w io.Writer, comma rune) *Writer {
	cw := csv.NewWriter(w)
	if comma != 0 {
		cw.Comma = comma
	}
	return &Writer{w: cw}
}

// Write writes one record. After the first error, writes are ignored and
// Flush reports it.
func (w *Writer) Write(record ...string) {
	if w.err != nil {
		return
	}
	w.err = w.w.Write(record)
}

// Flush writes buffered data and returns the first error seen.
func (w *Writer) Flush() error {
	w.w.Flush()
	if w.err != nil {
		return w.err
	}
	return w.w.Error()
}
