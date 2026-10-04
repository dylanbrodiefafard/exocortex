// Package cron parses standard five-field cron expressions and computes the
// times at which they fire.
package cron

import (
	"strconv"
	"strings"
	"time"
)

// Schedule is a parsed cron expression.
type Schedule struct {
	expr   string
	minute uint64 // bit i set: minute i matches
	hour   uint64
	dom    uint64
	month  uint64
	dow    uint64
}

type field struct {
	name     string
	min, max int
}

var fields = [5]field{
	{"minute", 0, 59},
	{"hour", 0, 23},
	{"day-of-month", 1, 31},
	{"month", 1, 12},
	{"day-of-week", 0, 6},
}

// Parse parses a cron expression.
func Parse(expr string) (*Schedule, error) {
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return nil, &ParseError{Expr: expr, Field: "", Msg: "expected 5 fields, got " + strconv.Itoa(len(parts))}
	}
	var sets [5]uint64
	for i, p := range parts {
		set, err := parseField(p, fields[i])
		if err != nil {
			return nil, err
		}
		sets[i] = set
	}
	return &Schedule{
		expr:   expr,
		minute: sets[0],
		hour:   sets[1],
		dom:    sets[2],
		month:  sets[3],
		dow:    sets[4],
	}, nil
}

// MustParse is like Parse but panics on error.
func MustParse(expr string) *Schedule {
	s, err := Parse(expr)
	if err != nil {
		panic(err)
	}
	return s
}

func parseField(text string, f field) (uint64, error) {
	var set uint64
	for _, item := range strings.Split(text, ",") {
		lo, hi := f.min, f.max
		if item != "*" {
			a, b, isRange := strings.Cut(item, "-")
			var err error
			lo, err = strconv.Atoi(a)
			if err != nil {
				return 0, &ParseError{Field: f.name, Msg: "bad value " + strconv.Quote(a)}
			}
			hi = lo
			if isRange {
				hi, err = strconv.Atoi(b)
				if err != nil {
					return 0, &ParseError{Field: f.name, Msg: "bad value " + strconv.Quote(b)}
				}
			}
		}
		for v := lo; v <= hi; v++ {
			set |= 1 << uint(v)
		}
	}
	return set, nil
}

// String returns the expression the schedule was parsed from.
func (s *Schedule) String() string { return s.expr }

// Matches reports whether t (ignoring seconds) is a time the schedule fires.
func (s *Schedule) Matches(t time.Time) bool {
	return s.minute&(1<<uint(t.Minute())) != 0 &&
		s.hour&(1<<uint(t.Hour())) != 0 &&
		s.month&(1<<uint(t.Month())) != 0 &&
		s.dom&(1<<uint(t.Day())) != 0 &&
		s.dow&(1<<uint(t.Weekday())) != 0
}

// Next returns the first time after `after` at which the schedule fires.
func (s *Schedule) Next(after time.Time) time.Time {
	t := after.Truncate(time.Minute)
	limit := after.AddDate(1, 0, 0)
	for !t.After(limit) {
		if s.Matches(t) {
			return t
		}
		t = t.Add(time.Minute)
	}
	return time.Time{}
}
