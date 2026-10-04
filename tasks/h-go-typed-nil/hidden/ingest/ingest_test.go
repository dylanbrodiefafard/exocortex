package ingest

import (
	"fmt"
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

func manyBatches() []Batch {
	kinds := []reading.Kind{reading.Temp, reading.Humidity, reading.CO2}
	values := map[reading.Kind][]float64{
		reading.Temp:     {21.5, -50, 18.25, 90, 0},
		reading.Humidity: {40, 101, 55.5, -1, 100},
		reading.CO2:      {400, 100, 1250.75, 20000, 250},
	}
	var out []Batch
	for g := 0; g < 24; g++ {
		b := Batch{Gateway: fmt.Sprintf("gw-%02d", g)}
		for i := 0; i < 30; i++ {
			k := kinds[(g+i)%3]
			sensor := fmt.Sprintf("s-%d", (g*7+i)%5)
			if (g+i)%11 == 0 {
				sensor = "Bad_" + sensor
			}
			b.Readings = append(b.Readings, reading.Reading{
				Sensor: sensor,
				Time:   int64(1000 + 10*i - (g % 3)),
				Kind:   k,
				Value:  values[k][(g*3+i)%5],
				Line:   i + 1,
			})
		}
		out = append(out, b)
	}
	return out
}

func TestResultIndependentOfWorkers(t *testing.T) {
	batches := manyBatches()
	opts := Options{Workers: 1, Window: validate.Window{NotBefore: 999, NotAfter: 1280}}
	base := Run(batches, opts)
	if base.Accepted == 0 || len(base.Rejected) == 0 {
		t.Fatalf("fixture should have both outcomes: %d accepted, %d rejected", base.Accepted, len(base.Rejected))
	}
	if base.Accepted+len(base.Rejected) != 24*30 {
		t.Fatalf("accepted %d + rejected %d != %d", base.Accepted, len(base.Rejected), 24*30)
	}
	for _, workers := range []int{0, 2, 8, 16} {
		for round := 0; round < 5; round++ {
			opts.Workers = workers
			got := Run(batches, opts)
			if got.Accepted != base.Accepted ||
				!reflect.DeepEqual(got.Rejected, base.Rejected) ||
				!reflect.DeepEqual(got.Stats, base.Stats) ||
				!reflect.DeepEqual(got.ByRule, base.ByRule) {
				t.Fatalf("workers=%d round %d: report differs from single worker", workers, round)
			}
		}
	}
	total := 0
	for _, rj := range base.Rejected {
		if len(rj.Rules) == 0 || rj.Reason == "" {
			t.Errorf("rejection without rules or reason: %+v", rj)
		}
		total += len(rj.Rules)
	}
	sum := 0
	for _, n := range base.ByRule {
		sum += n
	}
	if sum != total {
		t.Errorf("ByRule sums to %d, rejections list %d rule violations", sum, total)
	}
}

func TestAllValid(t *testing.T) {
	rep := Run([]Batch{batch(t, "east", "a-1 5 temp 1\na-1 6 temp 3\na-2 5 humidity 50")}, Options{Workers: 2})
	if rep.Accepted != 3 || len(rep.Rejected) != 0 || len(rep.ByRule) != 0 {
		t.Fatalf("got accepted=%d rejected=%v byRule=%v", rep.Accepted, rep.Rejected, rep.ByRule)
	}
	if s := rep.Stats[Key{"a-1", reading.Temp}]; s != (Stats{Count: 2, Min: 1, Max: 3, Sum: 4}) || s.Mean() != 2 {
		t.Errorf("stats %+v", s)
	}
}
