package ratelimit

import "time"

// Clock is the source of time for a Limiter. Production code uses RealClock;
// tests use FakeClock so that refills and waits are deterministic.
type Clock interface {
	Now() time.Time
	// NewTimer returns a Timer that delivers the current time on its channel
	// once d has elapsed.
	NewTimer(d time.Duration) Timer
}

// Timer is the subset of *time.Timer that Limiter needs.
type Timer interface {
	C() <-chan time.Time
	// Stop prevents the Timer from firing. It reports whether the call
	// stopped the timer (false if it had already fired or been stopped).
	Stop() bool
}

// RealClock is a Clock backed by the time package.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) NewTimer(d time.Duration) Timer { return realTimer{time.NewTimer(d)} }

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time { return r.t.C }
func (r realTimer) Stop() bool          { return r.t.Stop() }
