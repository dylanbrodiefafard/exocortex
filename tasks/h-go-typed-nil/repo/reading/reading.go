// Package reading parses sensor readings from the line format used by field
// gateways:
//
//	<sensor-id> <unix-seconds> <kind> <value>
//
// for example "greenhouse-3 1717000000 temp 21.5". Kind is one of temp (°C),
// humidity (%RH) or co2 (ppm).
package reading

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Kind is the measured quantity.
type Kind string

const (
	Temp     Kind = "temp"
	Humidity Kind = "humidity"
	CO2      Kind = "co2"
)

// Reading is one measurement.
type Reading struct {
	Sensor string
	Time   int64
	Kind   Kind
	Value  float64
	// Line is the 1-based line number in the source batch.
	Line int
}

// ParseError reports a malformed line.
type ParseError struct {
	Line int
	Msg  string
}

func (e *ParseError) Error() string { return fmt.Sprintf("line %d: %s", e.Line, e.Msg) }

// ParseLine parses a single line. lineNo is recorded in the result.
func ParseLine(line string, lineNo int) (Reading, error) {
	f := strings.Fields(line)
	if len(f) != 4 {
		return Reading{}, &ParseError{lineNo, fmt.Sprintf("want 4 fields, got %d", len(f))}
	}
	ts, err := strconv.ParseInt(f[1], 10, 64)
	if err != nil {
		return Reading{}, &ParseError{lineNo, "bad timestamp " + strconv.Quote(f[1])}
	}
	kind := Kind(f[2])
	switch kind {
	case Temp, Humidity, CO2:
	default:
		return Reading{}, &ParseError{lineNo, "unknown kind " + strconv.Quote(f[2])}
	}
	v, err := strconv.ParseFloat(f[3], 64)
	if err != nil {
		return Reading{}, &ParseError{lineNo, "bad value " + strconv.Quote(f[3])}
	}
	return Reading{Sensor: f[0], Time: ts, Kind: kind, Value: v, Line: lineNo}, nil
}

// Parse reads a whole batch. Blank lines and lines starting with '#' are
// skipped. It stops at the first malformed line.
func Parse(r io.Reader) ([]Reading, error) {
	var out []Reading
	sc := bufio.NewScanner(r)
	n := 0
	for sc.Scan() {
		n++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		rd, err := ParseLine(line, n)
		if err != nil {
			return nil, err
		}
		out = append(out, rd)
	}
	return out, sc.Err()
}
