package report

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"example.com/ledger/parser"
)

const checkingExport = `# checking, exported 2024-03-01
2024-01-02,chk-0101,checking,salary,3200.00
2024-01-03,chk-0102,checking,rent,-1450.00
2024-01-05,chk-0103,checking,transfer,-500.00
2024-01-18,chk-0104,checking,utilities,-86.40
2024-02-01,chk-0201,checking,salary,3200.00
2024-02-02,chk-0202,checking,rent,-1450.00
2024-02-16,chk-0203,checking,utilities,-91.25,pending
`

const cardExport = `# card, exported 2024-03-01
2024-01-04,card-0101,card,groceries,-63.20
2024-01-12,card-0102,card,dining,-38.50
2024-01-29,card-0103,card,groceries,-71.05
2024-02-03,card-0201,card,groceries,-58.90
2024-02-10,card-0202,card,dining,-112.00
2024-02-24,card-0203,card,groceries,-66.75
`

func load(t *testing.T, exports ...string) []parser.Entry {
	t.Helper()
	var all []parser.Entry
	for _, export := range exports {
		entries, err := parser.Parse(strings.NewReader(export))
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, entries...)
	}
	return all
}

func checkSummaries(t *testing.T, got, want []MonthSummary) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d months, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			t.Errorf("month %d:\n got  %+v\n want %+v", i, got[i], want[i])
		}
	}
}

func TestMonthlySingleExport(t *testing.T) {
	got := Monthly(load(t, checkingExport), 2024, []string{"transfer"})
	checkSummaries(t, got, []MonthSummary{
		{Month: time.January, Count: 3, Net: 166360, ByCategory: map[string]int64{"salary": 320000, "rent": -145000, "utilities": -8640}, YearToDate: 166360},
		{Month: time.February, Count: 2, Net: 175000, ByCategory: map[string]int64{"salary": 320000, "rent": -145000}, YearToDate: 341360},
	})
}

func TestMonthlyTwoExports(t *testing.T) {
	got := Monthly(load(t, checkingExport, cardExport), 2024, []string{"transfer"})
	checkSummaries(t, got, []MonthSummary{
		{
			Month: time.January, Count: 6, Net: 149085,
			ByCategory: map[string]int64{"salary": 320000, "rent": -145000, "utilities": -8640, "groceries": -13425, "dining": -3850},
			YearToDate: 149085,
		},
		{
			Month: time.February, Count: 5, Net: 151235,
			ByCategory: map[string]int64{"salary": 320000, "rent": -145000, "groceries": -12565, "dining": -11200},
			YearToDate: 300320,
		},
	})
}

func TestMonthlyOtherYear(t *testing.T) {
	if got := Monthly(load(t, checkingExport, cardExport), 2023, nil); len(got) != 0 {
		t.Errorf("Monthly(2023) = %+v, want nothing", got)
	}
}

func TestRender(t *testing.T) {
	var b strings.Builder
	err := Render(&b, []MonthSummary{
		{Month: time.January, Count: 2, Net: -4550, ByCategory: map[string]int64{"dining": -1250, "groceries": -3300}, YearToDate: -4550},
		{Month: time.February, Count: 1, Net: 120005, ByCategory: map[string]int64{"salary": 120005}, YearToDate: 115455},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "" +
		"month     count          net          ytd  top category\n" +
		"January       2       -45.50       -45.50  groceries\n" +
		"February      1      1200.05      1154.55  salary\n"
	if b.String() != want {
		t.Errorf("Render =\n%s\nwant\n%s", b.String(), want)
	}
}
