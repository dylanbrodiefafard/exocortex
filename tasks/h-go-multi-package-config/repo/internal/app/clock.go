package app

import "time"

// Clock abstracts time so tests can run without real waiting.
type Clock interface {
	Now() time.Time
	Sleep(d time.Duration)
}

type systemClock struct{}

func (systemClock) Now() time.Time        { return time.Now() }
func (systemClock) Sleep(d time.Duration) { time.Sleep(d) }

// SystemClock is the real wall clock.
var SystemClock Clock = systemClock{}
