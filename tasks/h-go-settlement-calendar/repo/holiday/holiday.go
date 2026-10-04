// Package holiday computes the public holidays observed by the settlement calendar.
// See README.md for the rules.
package holiday

import (
	"fmt"
	"sort"
	"time"
)

// MinYear and MaxYear bound the years the calendar supports.
const (
	MinYear = 1900
	MaxYear = 2199
)

// Holiday is one public holiday in a given year.
type Holiday struct {
	Name string
	// Date is the calendar date of the holiday itself.
	Date time.Time
	// Observed is the day offices are closed for it. It differs from Date only when
	// Date falls on a weekend.
	Observed time.Time
}

// Date returns midnight UTC on the given day.
func Date(year int, month time.Month, day int) time.Time {
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

// Easter returns Easter Sunday of the given Gregorian year.
func Easter(year int) time.Time {
	a := year % 19
	b := year / 100
	c := year % 100
	d := b / 4
	e := b % 4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i := c / 4
	k := c % 4
	l := (32 + 2*e + 2*i - h - k) % 7
	m := (a + 11*h + 22*l) / 541
	n := h + l - 7*m + 114
	return Date(year, time.Month(n/31), n%31+1)
}

func firstWeekday(year int, month time.Month, wd time.Weekday) time.Time {
	t := Date(year, month, 1)
	for t.Weekday() != wd {
		t = t.AddDate(0, 0, 1)
	}
	return t
}

func lastWeekday(year int, month time.Month, wd time.Weekday) time.Time {
	t := Date(year, month+1, 1).AddDate(0, 0, -1)
	for t.Weekday() != wd {
		t = t.AddDate(0, 0, -1)
	}
	return t
}

func isWeekend(t time.Time) bool {
	wd := t.Weekday()
	return wd == time.Saturday || wd == time.Sunday
}

// ForYear returns the holidays of year in calendar order.
func ForYear(year int) ([]Holiday, error) {
	if year < MinYear || year > MaxYear {
		return nil, fmt.Errorf("holiday: year %d outside %d..%d", year, MinYear, MaxYear)
	}
	easter := Easter(year)
	hs := []Holiday{
		{Name: "New Year's Day", Date: Date(year, time.January, 1)},
		{Name: "Good Friday", Date: easter.AddDate(0, 0, -2)},
		{Name: "Easter Monday", Date: easter.AddDate(0, 0, 1)},
		{Name: "Early May Bank Holiday", Date: firstWeekday(year, time.May, time.Monday)},
		{Name: "Spring Bank Holiday", Date: lastWeekday(year, time.May, time.Monday)},
		{Name: "Summer Bank Holiday", Date: lastWeekday(year, time.August, time.Monday)},
		{Name: "Christmas Day", Date: Date(year, time.December, 25)},
		{Name: "Boxing Day", Date: Date(year, time.December, 26)},
	}
	sort.SliceStable(hs, func(i, j int) bool { return hs[i].Date.Before(hs[j].Date) })
	taken := map[time.Time]bool{}
	for i := range hs {
		obs := hs[i].Date
		for isWeekend(obs) || taken[obs] {
			obs = obs.AddDate(0, 0, 1)
		}
		taken[obs] = true
		hs[i].Observed = obs
	}
	return hs, nil
}

// IsObserved reports whether offices are closed on day t for a holiday.
func IsObserved(t time.Time) bool {
	hs, err := ForYear(t.Year())
	if err != nil {
		return false
	}
	day := Date(t.Year(), t.Month(), t.Day())
	for _, h := range hs {
		if h.Observed.Equal(day) {
			return true
		}
	}
	return false
}
