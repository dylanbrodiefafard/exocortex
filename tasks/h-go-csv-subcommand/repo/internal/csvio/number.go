package csvio

import (
	"math"
	"strconv"
	"strings"
)

// ParseNumber parses a numeric cell. Surrounding spaces are ignored; empty
// cells, NaN and infinities are not numbers.
func ParseNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// FormatNumber formats a number the shortest way that reads back exactly.
func FormatNumber(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
