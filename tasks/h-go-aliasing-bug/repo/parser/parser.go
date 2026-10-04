// Package parser reads ledger exports.
//
// An export is a CSV file with one entry per line:
//
//	date,id,account,category,amount[,status]
//
// date is YYYY-MM-DD, amount is a decimal with at most two fractional digits
// (negative for money going out), and status is "posted" (the default) or
// "pending". Blank lines and lines starting with '#' are ignored.
package parser

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// Date is a calendar date without a time zone.
type Date struct {
	Year  int
	Month time.Month
	Day   int
}

// ParseDate parses a YYYY-MM-DD date.
func ParseDate(s string) (Date, error) {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return Date{}, fmt.Errorf("invalid date %q", s)
	}
	return Date{Year: t.Year(), Month: t.Month(), Day: t.Day()}, nil
}

// Compare returns -1, 0 or 1 as d is before, equal to or after o.
func (d Date) Compare(o Date) int {
	switch {
	case d.Year != o.Year:
		return cmpInt(d.Year, o.Year)
	case d.Month != o.Month:
		return cmpInt(int(d.Month), int(o.Month))
	default:
		return cmpInt(d.Day, o.Day)
	}
}

func (d Date) String() string {
	return fmt.Sprintf("%04d-%02d-%02d", d.Year, int(d.Month), d.Day)
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// Entry is one ledger line. Amount is in cents.
type Entry struct {
	ID       string
	Date     Date
	Account  string
	Category string
	Amount   int64
	Pending  bool
}

// Parse reads every entry in an export, in file order.
func Parse(r io.Reader) ([]Entry, error) {
	var entries []Entry
	sc := bufio.NewScanner(r)
	line := 0
	for sc.Scan() {
		line++
		text := strings.TrimSpace(sc.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		e, err := parseLine(text)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		entries = append(entries, e)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

func parseLine(text string) (Entry, error) {
	fields := strings.Split(text, ",")
	if len(fields) != 5 && len(fields) != 6 {
		return Entry{}, fmt.Errorf("want 5 or 6 fields, got %d", len(fields))
	}
	for i := range fields {
		fields[i] = strings.TrimSpace(fields[i])
	}
	date, err := ParseDate(fields[0])
	if err != nil {
		return Entry{}, err
	}
	if fields[1] == "" {
		return Entry{}, fmt.Errorf("missing id")
	}
	amount, err := ParseAmount(fields[4])
	if err != nil {
		return Entry{}, err
	}
	e := Entry{ID: fields[1], Date: date, Account: fields[2], Category: fields[3], Amount: amount}
	if len(fields) == 6 {
		switch fields[5] {
		case "", "posted":
		case "pending":
			e.Pending = true
		default:
			return Entry{}, fmt.Errorf("unknown status %q", fields[5])
		}
	}
	return e, nil
}

// ParseAmount parses a decimal amount such as "-12.5" or "300" into cents.
func ParseAmount(s string) (int64, error) {
	neg := strings.HasPrefix(s, "-")
	digits := strings.TrimPrefix(strings.TrimPrefix(s, "-"), "+")
	whole, frac, hasFrac := strings.Cut(digits, ".")
	if whole == "" || (hasFrac && (frac == "" || len(frac) > 2)) {
		return 0, fmt.Errorf("invalid amount %q", s)
	}
	for len(frac) < 2 {
		frac += "0"
	}
	n, err := strconv.ParseInt(whole+frac, 10, 64)
	if err != nil || strings.ContainsAny(whole+frac, "+-") {
		return 0, fmt.Errorf("invalid amount %q", s)
	}
	if neg {
		n = -n
	}
	return n, nil
}
