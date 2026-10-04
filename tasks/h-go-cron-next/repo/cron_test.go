package cron

import (
	"errors"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04", s)
	if err != nil {
		panic(err)
	}
	return t
}

func checkNext(t *testing.T, expr, from, want string) {
	t.Helper()
	s, err := Parse(expr)
	if err != nil {
		t.Fatalf("Parse(%q): %v", expr, err)
	}
	got := s.Next(at(from))
	if !got.Equal(at(want)) {
		t.Errorf("Parse(%q).Next(%s) = %s, want %s", expr, from, got.Format("2006-01-02 15:04 Mon"), want)
	}
}

func TestDaily(t *testing.T) {
	checkNext(t, "30 9 * * *", "2024-03-10 08:00", "2024-03-10 09:30")
	checkNext(t, "30 9 * * *", "2024-03-10 10:00", "2024-03-11 09:30")
}

func TestListsAndRanges(t *testing.T) {
	checkNext(t, "0,15,30,45 * * * *", "2024-03-10 08:16", "2024-03-10 08:30")
	checkNext(t, "0 9-17 * * *", "2024-03-10 17:30", "2024-03-11 09:00")
}

func TestSteps(t *testing.T) {
	checkNext(t, "*/15 * * * *", "2024-03-10 08:16", "2024-03-10 08:30")
	checkNext(t, "0 */6 * * *", "2024-03-10 13:00", "2024-03-10 18:00")
}

func TestMonthRollover(t *testing.T) {
	checkNext(t, "0 0 1 * *", "2024-12-15 12:00", "2025-01-01 00:00")
}

func TestDayOfWeek(t *testing.T) {
	// 2024-03-10 is a Sunday.
	checkNext(t, "0 12 * * 3", "2024-03-10 00:00", "2024-03-13 12:00")
}

func TestWrongFieldCount(t *testing.T) {
	_, err := Parse("* * * *")
	var pe *ParseError
	if !errors.As(err, &pe) {
		t.Fatalf("Parse with 4 fields: got %v, want *ParseError", err)
	}
}
