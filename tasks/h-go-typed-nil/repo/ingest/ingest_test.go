package ingest

import (
	"reflect"
	"strings"
	"testing"

	"example.com/telemetry/reading"
	"example.com/telemetry/validate"
)

func batch(t *testing.T, gateway, text string) Batch {
	t.Helper()
	rs, err := reading.Parse(strings.NewReader(text))
	if err != nil {
		t.Fatal(err)
	}
	return Batch{Gateway: gateway, Readings: rs}
}

func fixtures(t *testing.T) []Batch {
	return []Batch{
		batch(t, "north", `gh-1 1000 temp 120
gh-1 1000 temp 21.5
gh-1 1060 temp 22.5
gh-1 1060 humidity 61
gh-2 1000 co2 812`),
		batch(t, "south", `gh-3 900 humidity 140
gh-3 1000 temp 18.25
GH-4 1000 temp 19
gh-3 1060 temp 18.75`),
		batch(t, "west", `bad- 1000 co2 5
gh-5 1000 co2 640
gh-5 1060 co2 660`),
	}
}

func TestRunAggregatesAcceptedReadings(t *testing.T) {
	rep := Run(fixtures(t), Options{Workers: 3, Window: validate.Window{NotBefore: 950}})
	if rep.Accepted != 8 {
		t.Errorf("accepted %d, want 8", rep.Accepted)
	}
	want := map[Key]Stats{
		{"gh-1", reading.Temp}:     {Count: 2, Min: 21.5, Max: 22.5, Sum: 44},
		{"gh-1", reading.Humidity}: {Count: 1, Min: 61, Max: 61, Sum: 61},
		{"gh-2", reading.CO2}:      {Count: 1, Min: 812, Max: 812, Sum: 812},
		{"gh-3", reading.Temp}:     {Count: 2, Min: 18.25, Max: 18.75, Sum: 37},
		{"gh-5", reading.CO2}:      {Count: 2, Min: 640, Max: 660, Sum: 1300},
	}
	if !reflect.DeepEqual(rep.Stats, want) {
		t.Errorf("stats:\n got  %v\n want %v", rep.Stats, want)
	}
	if m := rep.Stats[Key{"gh-3", reading.Temp}].Mean(); m != 18.5 {
		t.Errorf("mean %v", m)
	}
}

func TestRunRecordsRejections(t *testing.T) {
	rep := Run(fixtures(t), Options{Workers: 3, Window: validate.Window{NotBefore: 950}})
	want := []Rejection{
		{Gateway: "north", Line: 1, Rules: []string{"range"}, Reason: "line 1: range: temp 120 outside [-40, 85]"},
		{Gateway: "south", Line: 1, Rules: []string{"range", "time"}, Reason: "line 1: range: humidity 140 outside [0, 100]; time: timestamp 900 before 950"},
		{Gateway: "south", Line: 3, Rules: []string{"sensor-id"}, Reason: `line 3: sensor-id: invalid sensor id "GH-4"`},
		{Gateway: "west", Line: 1, Rules: []string{"range", "sensor-id"}, Reason: `line 1: sensor-id: invalid sensor id "bad-"; range: co2 5 outside [250, 10000]`},
	}
	if !reflect.DeepEqual(rep.Rejected, want) {
		t.Errorf("rejected:\n got  %+v\n want %+v", rep.Rejected, want)
	}
	if want := map[string]int{"range": 3, "time": 1, "sensor-id": 2}; !reflect.DeepEqual(rep.ByRule, want) {
		t.Errorf("by rule: got %v want %v", rep.ByRule, want)
	}
}
