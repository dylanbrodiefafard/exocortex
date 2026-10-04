// Package pipeline selects and orders ledger entries for reporting.
package pipeline

import (
	"sort"

	"example.com/ledger/parser"
)

// Options selects entries. Zero values select everything.
type Options struct {
	// From and To bound the entry date, inclusive. A zero Date leaves that end open.
	From, To parser.Date
	// Accounts, if non-empty, keeps only entries posted to one of these accounts.
	Accounts []string
	// ExcludeCategories drops entries in any of these categories.
	ExcludeCategories []string
	// IncludePending keeps pending entries; by default only posted entries are kept.
	IncludePending bool
}

type stage func([]parser.Entry) []parser.Entry

// Run returns the entries selected by opts, ordered by date and then ID.
// It does not modify entries; callers may run several selections over the
// same slice.
func Run(entries []parser.Entry, opts Options) []parser.Entry {
	stages := []stage{
		where(func(e parser.Entry) bool { return opts.IncludePending || !e.Pending }),
		where(inPeriod(opts.From, opts.To)),
		where(inAccounts(opts.Accounts)),
		where(notInCategories(opts.ExcludeCategories)),
		byDateThenID,
	}
	out := entries
	for _, s := range stages {
		out = s(out)
	}
	return out
}

func where(keep func(parser.Entry) bool) stage {
	return func(in []parser.Entry) []parser.Entry {
		out := in[:0]
		for _, e := range in {
			if keep(e) {
				out = append(out, e)
			}
		}
		return out
	}
}

func byDateThenID(in []parser.Entry) []parser.Entry {
	sort.SliceStable(in, func(i, j int) bool {
		if c := in[i].Date.Compare(in[j].Date); c != 0 {
			return c < 0
		}
		return in[i].ID < in[j].ID
	})
	return in
}

func inPeriod(from, to parser.Date) func(parser.Entry) bool {
	return func(e parser.Entry) bool {
		if from != (parser.Date{}) && e.Date.Compare(from) < 0 {
			return false
		}
		if to != (parser.Date{}) && e.Date.Compare(to) > 0 {
			return false
		}
		return true
	}
}

func inAccounts(accounts []string) func(parser.Entry) bool {
	set := toSet(accounts)
	return func(e parser.Entry) bool { return len(set) == 0 || set[e.Account] }
}

func notInCategories(categories []string) func(parser.Entry) bool {
	set := toSet(categories)
	return func(e parser.Entry) bool { return !set[e.Category] }
}

func toSet(items []string) map[string]bool {
	set := make(map[string]bool, len(items))
	for _, it := range items {
		set[it] = true
	}
	return set
}
