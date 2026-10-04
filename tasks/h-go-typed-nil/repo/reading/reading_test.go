package reading

import (
	"errors"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	in := "# gateway 7\ngh-1 100 temp 21.5\n\ngh-1 100 humidity 55\n"
	got, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	want := []Reading{
		{Sensor: "gh-1", Time: 100, Kind: Temp, Value: 21.5, Line: 2},
		{Sensor: "gh-1", Time: 100, Kind: Humidity, Value: 55, Line: 4},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("reading %d: got %+v want %+v", i, got[i], want[i])
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, line := range []string{"gh-1 100 temp", "gh-1 x temp 1", "gh-1 100 lux 1", "gh-1 100 temp warm"} {
		_, err := ParseLine(line, 3)
		var pe *ParseError
		if !errors.As(err, &pe) || pe.Line != 3 {
			t.Errorf("%q: got %v", line, err)
		}
	}
}
