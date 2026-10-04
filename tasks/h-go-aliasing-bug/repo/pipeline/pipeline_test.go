package pipeline

import (
	"strings"
	"testing"
	"time"

	"example.com/ledger/parser"
)

const sample = `2024-01-20,b-2,card,groceries,-20.00
2024-01-05,a-1,checking,rent,-1000.00
2024-01-20,a-3,checking,transfer,-50.00
2024-02-01,a-4,checking,salary,2500.00
2024-01-20,a-2,checking,groceries,-15.00,pending
2024-01-09,b-1,card,dining,-30.00
`

func mustParse(t *testing.T, s string) []parser.Entry {
	t.Helper()
	entries, err := parser.Parse(strings.NewReader(s))
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func ids(entries []parser.Entry) string {
	var out []string
	for _, e := range entries {
		out = append(out, e.ID)
	}
	return strings.Join(out, ",")
}

func TestRunSelectsAndOrders(t *testing.T) {
	jan := Options{From: parser.Date{Year: 2024, Month: time.January, Day: 1}, To: parser.Date{Year: 2024, Month: time.January, Day: 31}}
	cases := []struct {
		name string
		opts Options
		want string
	}{
		{"everything posted", Options{}, "a-1,b-1,a-3,b-2,a-4"},
		{"with pending", Options{IncludePending: true}, "a-1,b-1,a-2,a-3,b-2,a-4"},
		{"january", jan, "a-1,b-1,a-3,b-2"},
		{"from only", Options{From: parser.Date{Year: 2024, Month: time.January, Day: 20}}, "a-3,b-2,a-4"},
		{"card", Options{Accounts: []string{"card"}}, "b-1,b-2"},
		{"exclude", Options{ExcludeCategories: []string{"transfer", "salary"}}, "a-1,b-1,b-2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ids(Run(mustParse(t, sample), tc.opts)); got != tc.want {
				t.Errorf("Run = %s, want %s", got, tc.want)
			}
		})
	}
}
