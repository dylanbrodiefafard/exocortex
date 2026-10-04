// Package ingest validates batches of readings from many gateways
// concurrently and aggregates the ones that pass.
package ingest

import (
	"errors"
	"sort"
	"sync"

	"example.com/telemetry/reading"
	"example.com/telemetry/validate"
)

// Batch is the set of readings uploaded by one gateway.
type Batch struct {
	Gateway  string
	Readings []reading.Reading
}

// Rejection records a reading that failed validation.
type Rejection struct {
	Gateway string
	Line    int
	// Rules lists the violated rules, sorted, without duplicates.
	Rules []string
	// Reason is the validation error's message.
	Reason string
}

// Stats summarizes accepted readings of one kind from one sensor.
type Stats struct {
	Count         int
	Min, Max, Sum float64
}

// Mean is Sum/Count, or 0 for no readings.
func (s Stats) Mean() float64 {
	if s.Count == 0 {
		return 0
	}
	return s.Sum / float64(s.Count)
}

// Key identifies a sensor/kind pair.
type Key struct {
	Sensor string
	Kind   reading.Kind
}

// Report is the outcome of Run.
type Report struct {
	Accepted int
	// Rejected is sorted by gateway, then line.
	Rejected []Rejection
	// Stats covers accepted readings only.
	Stats map[Key]Stats
	// ByRule counts rejected readings per violated rule.
	ByRule map[string]int

	mu sync.Mutex
}

// Options configures Run.
type Options struct {
	// Workers is the number of goroutines validating batches; 0 means 4.
	Workers int
	Window  validate.Window
}

// Run validates every reading in every batch using opts.Workers goroutines.
// The report does not depend on the number of workers or on scheduling.
func Run(batches []Batch, opts Options) *Report {
	workers := opts.Workers
	if workers <= 0 {
		workers = 4
	}
	rep := &Report{Stats: map[Key]Stats{}, ByRule: map[string]int{}}

	jobs := make(chan Batch)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for b := range jobs {
				for _, r := range b.Readings {
					if err := validate.Check(r, opts.Window); err != nil {
						rep.reject(b.Gateway, r, err)
						continue
					}
					rep.accept(r)
				}
			}
		}()
	}
	for _, b := range batches {
		jobs <- b
	}
	close(jobs)
	wg.Wait()

	sort.Slice(rep.Rejected, func(i, j int) bool {
		a, b := rep.Rejected[i], rep.Rejected[j]
		if a.Gateway != b.Gateway {
			return a.Gateway < b.Gateway
		}
		return a.Line < b.Line
	})
	return rep
}

func (rep *Report) accept(r reading.Reading) {
	rep.mu.Lock()
	defer rep.mu.Unlock()
	rep.Accepted++
	k := Key{r.Sensor, r.Kind}
	s, ok := rep.Stats[k]
	if !ok || r.Value < s.Min {
		s.Min = r.Value
	}
	if !ok || r.Value > s.Max {
		s.Max = r.Value
	}
	s.Count++
	s.Sum += r.Value
	rep.Stats[k] = s
}

func (rep *Report) reject(gateway string, r reading.Reading, err error) {
	rj := Rejection{Gateway: gateway, Line: r.Line, Reason: err.Error()}
	var probs *validate.Problems
	if errors.As(err, &probs) {
		seen := map[string]bool{}
		for _, it := range probs.Items {
			if !seen[it.Rule] {
				seen[it.Rule] = true
				rj.Rules = append(rj.Rules, it.Rule)
			}
		}
		sort.Strings(rj.Rules)
	}
	for _, rule := range rj.Rules {
		rep.ByRule[rule]++
	}
	rep.Rejected = append(rep.Rejected, rj)
}
