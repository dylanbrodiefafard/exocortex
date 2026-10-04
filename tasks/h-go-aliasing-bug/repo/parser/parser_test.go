package parser

import (
	"strings"
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	input := `# exported 2024-03-01
2024-01-02,chk-1,checking,salary,3200
2024-01-03, chk-2 ,checking,rent,-1450.5

2024-01-04,chk-3,checking,groceries,-0.07,pending
2024-01-05,chk-4,checking,groceries,-12.30,posted
`
	got, err := Parse(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	want := []Entry{
		{ID: "chk-1", Date: Date{2024, time.January, 2}, Account: "checking", Category: "salary", Amount: 320000},
		{ID: "chk-2", Date: Date{2024, time.January, 3}, Account: "checking", Category: "rent", Amount: -145050},
		{ID: "chk-3", Date: Date{2024, time.January, 4}, Account: "checking", Category: "groceries", Amount: -7, Pending: true},
		{ID: "chk-4", Date: Date{2024, time.January, 5}, Account: "checking", Category: "groceries", Amount: -1230},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d entries, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, line := range []string{
		"2024-13-01,x,a,b,1",
		"2024-01-01,,a,b,1",
		"2024-01-01,x,a,b,1.234",
		"2024-01-01,x,a,b,abc",
		"2024-01-01,x,a,b,1,cleared",
		"2024-01-01,x,a,b",
	} {
		if _, err := Parse(strings.NewReader(line)); err == nil {
			t.Errorf("Parse(%q) succeeded, want error", line)
		}
	}
}

func TestDateCompare(t *testing.T) {
	a := Date{2024, time.January, 31}
	b := Date{2024, time.February, 1}
	if a.Compare(b) != -1 || b.Compare(a) != 1 || a.Compare(a) != 0 {
		t.Errorf("Compare is not ordering dates")
	}
	if a.String() != "2024-01-31" {
		t.Errorf("String() = %q", a.String())
	}
}
