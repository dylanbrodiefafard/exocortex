// Package validate applies plausibility rules to sensor readings.
package validate

import (
	"fmt"
	"strings"

	"example.com/telemetry/reading"
)

// Limits are the inclusive plausible ranges per kind.
var Limits = map[reading.Kind][2]float64{
	reading.Temp:     {-40, 85},
	reading.Humidity: {0, 100},
	reading.CO2:      {250, 10000},
}

// Rule names used in Problem.Rule.
const (
	RuleRange    = "range"
	RuleSensorID = "sensor-id"
	RuleTime     = "time"
)

// Problem is one rule violation.
type Problem struct {
	Rule   string
	Detail string
}

// Problems is the error returned when a reading violates one or more rules.
type Problems struct {
	Line  int
	Items []Problem
}

func (p *Problems) add(rule, format string, args ...any) {
	p.Items = append(p.Items, Problem{Rule: rule, Detail: fmt.Sprintf(format, args...)})
}

// Error lists every violation, e.g. "line 4: range: temp 99 outside [-40, 85]".
func (p *Problems) Error() string {
	parts := make([]string, len(p.Items))
	for i, it := range p.Items {
		parts[i] = it.Rule + ": " + it.Detail
	}
	return fmt.Sprintf("line %d: %s", p.Line, strings.Join(parts, "; "))
}

// Has reports whether rule is among the violations.
func (p *Problems) Has(rule string) bool {
	for _, it := range p.Items {
		if it.Rule == rule {
			return true
		}
	}
	return false
}

// Window bounds acceptable timestamps (inclusive). A zero bound is open.
type Window struct {
	NotBefore, NotAfter int64
}

// Check runs every rule against r. It returns nil if r passes all of them,
// and otherwise a *Problems listing every violation (not just the first).
func Check(r reading.Reading, w Window) error {
	var probs *Problems
	report := func(rule, format string, args ...any) {
		if probs == nil {
			probs = &Problems{Line: r.Line}
		}
		probs.add(rule, format, args...)
	}

	if !validSensorID(r.Sensor) {
		report(RuleSensorID, "invalid sensor id %q", r.Sensor)
	}
	if lim, ok := Limits[r.Kind]; ok && (r.Value < lim[0] || r.Value > lim[1]) {
		report(RuleRange, "%s %g outside [%g, %g]", r.Kind, r.Value, lim[0], lim[1])
	}
	if w.NotBefore != 0 && r.Time < w.NotBefore {
		report(RuleTime, "timestamp %d before %d", r.Time, w.NotBefore)
	}
	if w.NotAfter != 0 && r.Time > w.NotAfter {
		report(RuleTime, "timestamp %d after %d", r.Time, w.NotAfter)
	}
	return probs
}

// validSensorID: 1-32 chars of lowercase letters, digits and '-', not
// starting or ending with '-'.
func validSensorID(id string) bool {
	if len(id) == 0 || len(id) > 32 || id[0] == '-' || id[len(id)-1] == '-' {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}
