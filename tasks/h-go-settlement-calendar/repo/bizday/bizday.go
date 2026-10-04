// Package bizday does business-day arithmetic on the settlement calendar.
package bizday

import (
	"time"

	"example.com/workdays/holiday"
)

func day(t time.Time) time.Time { return holiday.Date(t.Year(), t.Month(), t.Day()) }

// IsBusinessDay reports whether t is a weekday on which offices are open.
func IsBusinessDay(t time.Time) bool {
	switch t.Weekday() {
	case time.Saturday, time.Sunday:
		return false
	}
	return !holiday.IsObserved(t)
}

// Next returns the first business day strictly after t.
func Next(t time.Time) time.Time {
	d := day(t).AddDate(0, 0, 1)
	for !IsBusinessDay(d) {
		d = d.AddDate(0, 0, 1)
	}
	return d
}

// Prev returns the last business day strictly before t.
func Prev(t time.Time) time.Time {
	d := day(t).AddDate(0, 0, -1)
	for !IsBusinessDay(d) {
		d = d.AddDate(0, 0, -1)
	}
	return d
}

// Add moves n business days from t: forwards for n > 0, backwards for n < 0.
// The starting day itself is never counted. With n == 0, Add returns t if it is a
// business day and otherwise the next business day.
func Add(t time.Time, n int) time.Time {
	d := day(t)
	if n == 0 {
		if IsBusinessDay(d) {
			return d
		}
		return Next(d)
	}
	for ; n > 0; n-- {
		d = Next(d)
	}
	for ; n < 0; n++ {
		d = Prev(d)
	}
	return d
}

// Between counts the business days in (a, b] when a is before b, and returns the
// negated count of business days in (b, a] when b is before a.
func Between(a, b time.Time) int {
	a, b = day(a), day(b)
	sign := 1
	if b.Before(a) {
		a, b = b, a
		sign = -1
	}
	n := 0
	for d := a.AddDate(0, 0, 1); !d.After(b); d = d.AddDate(0, 0, 1) {
		if IsBusinessDay(d) {
			n++
		}
	}
	return sign * n
}
