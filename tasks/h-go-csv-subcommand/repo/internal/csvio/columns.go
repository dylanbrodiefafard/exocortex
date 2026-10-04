package csvio

import (
	"fmt"
	"strconv"
	"strings"
)

// ResolveColumns turns a column selection into 0-based column indexes.
//
// spec is a comma-separated list of items. Each item is a column name, a
// 1-based index, or a range of indexes: "2-4", "3-" (to the last column)
// or "-2" (from the first). A name made only of digits is read as an
// index. Items may repeat and are returned in the order given. An empty
// spec selects every column.
func ResolveColumns(header []string, spec string) ([]int, error) {
	if strings.TrimSpace(spec) == "" {
		all := make([]int, len(header))
		for i := range all {
			all[i] = i
		}
		return all, nil
	}
	var cols []int
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, fmt.Errorf("empty item in column list %q", spec)
		}
		got, err := resolveItem(header, item)
		if err != nil {
			return nil, err
		}
		cols = append(cols, got...)
	}
	return cols, nil
}

func resolveItem(header []string, item string) ([]int, error) {
	if i := strings.Index(item, "-"); i >= 0 && isRange(item) {
		lo, hi := 1, len(header)
		var err error
		if left := item[:i]; left != "" {
			if lo, err = index(header, left); err != nil {
				return nil, err
			}
		}
		if right := item[i+1:]; right != "" {
			if hi, err = index(header, right); err != nil {
				return nil, err
			}
		}
		if lo > hi {
			return nil, fmt.Errorf("invalid column range %q", item)
		}
		out := make([]int, 0, hi-lo+1)
		for c := lo; c <= hi; c++ {
			out = append(out, c-1)
		}
		return out, nil
	}
	if isDigits(item) {
		n, err := index(header, item)
		if err != nil {
			return nil, err
		}
		return []int{n - 1}, nil
	}
	for i, name := range header {
		if name == item {
			return []int{i}, nil
		}
	}
	return nil, fmt.Errorf("unknown column %q", item)
}

// index parses a 1-based column index and checks it against the header.
func index(header []string, s string) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("invalid column index %q", s)
	}
	if n > len(header) {
		return 0, fmt.Errorf("column index %d out of range (input has %d columns)", n, len(header))
	}
	return n, nil
}

func isRange(item string) bool {
	parts := strings.Split(item, "-")
	if len(parts) != 2 || (parts[0] == "" && parts[1] == "") {
		return false
	}
	return (parts[0] == "" || isDigits(parts[0])) && (parts[1] == "" || isDigits(parts[1]))
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
