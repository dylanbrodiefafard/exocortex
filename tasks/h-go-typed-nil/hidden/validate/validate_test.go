package validate

import (
	"errors"
	"testing"

	"example.com/telemetry/reading"
)

func problems(t *testing.T, err error) *Problems {
	t.Helper()
	var p *Problems
	if !errors.As(err, &p) {
		t.Fatalf("want *Problems, got %T %v", err, err)
	}
	return p
}

func TestOutOfRange(t *testing.T) {
	r := reading.Reading{Sensor: "gh-1", Time: 100, Kind: reading.Temp, Value: 99, Line: 4}
	p := problems(t, Check(r, Window{}))
	if !p.Has(RuleRange) || len(p.Items) != 1 {
		t.Fatalf("got %+v", p.Items)
	}
	if got, want := p.Error(), "line 4: range: temp 99 outside [-40, 85]"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestReportsEveryViolation(t *testing.T) {
	r := reading.Reading{Sensor: "GH_1", Time: 5, Kind: reading.CO2, Value: 12, Line: 9}
	p := problems(t, Check(r, Window{NotBefore: 10}))
	for _, rule := range []string{RuleSensorID, RuleRange, RuleTime} {
		if !p.Has(rule) {
			t.Errorf("missing %s in %v", rule, p)
		}
	}
}

func TestSensorIDs(t *testing.T) {
	for id, ok := range map[string]bool{"gh-1": true, "a": true, "-a": false, "a-": false, "": false, "Ab": false} {
		if validSensorID(id) != ok {
			t.Errorf("%q: want %v", id, ok)
		}
	}
}

func TestValidReadingIsNil(t *testing.T) {
	for _, r := range []reading.Reading{
		{Sensor: "gh-1", Time: 100, Kind: reading.Temp, Value: 21.5, Line: 1},
		{Sensor: "a", Time: 100, Kind: reading.Humidity, Value: 0, Line: 2},
		{Sensor: "co2-sensor-7", Time: 100, Kind: reading.CO2, Value: 10000, Line: 3},
	} {
		if err := Check(r, Window{NotBefore: 100, NotAfter: 100}); err != nil {
			t.Errorf("%+v: want nil error, got %T", r, err)
		}
	}
}

func TestTimeWindow(t *testing.T) {
	r := reading.Reading{Sensor: "gh-1", Time: 300, Kind: reading.Temp, Value: 20, Line: 2}
	p := problems(t, Check(r, Window{NotAfter: 200}))
	if got, want := p.Error(), "line 2: time: timestamp 300 after 200"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
	if Check(r, Window{NotBefore: 300, NotAfter: 300}) != nil {
		t.Error("window bounds are inclusive")
	}
}
