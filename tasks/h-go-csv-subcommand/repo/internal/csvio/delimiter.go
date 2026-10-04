package csvio

import (
	"fmt"
	"unicode/utf8"
)

// ParseDelimiter reads the value of a -d flag: a single character, or one of
// the names "tab", "\t", "comma", "semicolon", "pipe".
func ParseDelimiter(s string) (rune, error) {
	switch s {
	case "tab", `\t`, "\t":
		return '\t', nil
	case "comma":
		return ',', nil
	case "semicolon":
		return ';', nil
	case "pipe":
		return '|', nil
	}
	r, size := utf8.DecodeRuneInString(s)
	if size == 0 || size != len(s) || r == utf8.RuneError {
		return 0, fmt.Errorf("delimiter must be a single character, got %q", s)
	}
	if r == '"' || r == '\r' || r == '\n' {
		return 0, fmt.Errorf("delimiter %q is not allowed", s)
	}
	return r, nil
}
