// Package report builds spending summaries from ledger entries.
package report

import (
	"fmt"
	"io"
	"sort"
	"time"

	"example.com/ledger/parser"
	"example.com/ledger/pipeline"
)

// MonthSummary covers the posted entries of one calendar month.
type MonthSummary struct {
	Month time.Month
	// Count is the number of entries in the month.
	Count int
	// Net is the sum of all amounts in the month, in cents.
	Net int64
	// ByCategory is the net amount per category, in cents.
	ByCategory map[string]int64
	// YearToDate is the net amount from January 1 through the end of the month.
	YearToDate int64
}

// Monthly summarizes the posted entries of year, one MonthSummary per month
// that has at least one entry, in calendar order. Entries in any of the
// excluded categories (for example "transfer") are ignored throughout.
func Monthly(entries []parser.Entry, year int, exclude []string) []MonthSummary {
	var out []MonthSummary
	for m := time.January; m <= time.December; m++ {
		rows := pipeline.Run(entries, pipeline.Options{
			From:              parser.Date{Year: year, Month: m, Day: 1},
			To:                lastDay(year, m),
			ExcludeCategories: exclude,
		})
		if len(rows) == 0 {
			continue
		}
		s := MonthSummary{Month: m, Count: len(rows), ByCategory: map[string]int64{}}
		for _, e := range rows {
			s.Net += e.Amount
			s.ByCategory[e.Category] += e.Amount
		}
		ytd := pipeline.Run(entries, pipeline.Options{
			From:              parser.Date{Year: year, Month: time.January, Day: 1},
			To:                lastDay(year, m),
			ExcludeCategories: exclude,
		})
		for _, e := range ytd {
			s.YearToDate += e.Amount
		}
		out = append(out, s)
	}
	return out
}

// AccountBalance is the net movement of one account over a period.
type AccountBalance struct {
	Account string
	Entries int
	Net     int64
}

// Accounts returns the net movement of each listed account between from and
// to (inclusive), counting posted entries only, in the order the accounts
// are given.
func Accounts(entries []parser.Entry, accounts []string, from, to parser.Date) []AccountBalance {
	out := make([]AccountBalance, 0, len(accounts))
	for _, acct := range accounts {
		rows := pipeline.Run(entries, pipeline.Options{From: from, To: to, Accounts: []string{acct}})
		b := AccountBalance{Account: acct, Entries: len(rows)}
		for _, e := range rows {
			b.Net += e.Amount
		}
		out = append(out, b)
	}
	return out
}

// Render writes summaries as a plain-text table.
func Render(w io.Writer, summaries []MonthSummary) error {
	if _, err := fmt.Fprintf(w, "%-9s %5s %12s %12s  %s\n", "month", "count", "net", "ytd", "top category"); err != nil {
		return err
	}
	for _, s := range summaries {
		top := topCategory(s.ByCategory)
		if _, err := fmt.Fprintf(w, "%-9s %5d %12s %12s  %s\n", s.Month, s.Count, money(s.Net), money(s.YearToDate), top); err != nil {
			return err
		}
	}
	return nil
}

// topCategory is the category with the largest outflow (most negative net),
// ties broken by name.
func topCategory(byCategory map[string]int64) string {
	names := make([]string, 0, len(byCategory))
	for name := range byCategory {
		names = append(names, name)
	}
	sort.Strings(names)
	best := ""
	for _, name := range names {
		if best == "" || byCategory[name] < byCategory[best] {
			best = name
		}
	}
	return best
}

func money(cents int64) string {
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", sign, cents/100, cents%100)
}

func lastDay(year int, m time.Month) parser.Date {
	t := time.Date(year, m+1, 0, 0, 0, 0, 0, time.UTC)
	return parser.Date{Year: t.Year(), Month: t.Month(), Day: t.Day()}
}
