// Package ratelimit provides a token-bucket rate limiter.
package ratelimit

import (
	"context"
	"sync"
)

// Limiter is a token-bucket rate limiter.
type Limiter struct {
	mu    sync.Mutex
	clock Clock
	rate  float64 // tokens per second
	burst int
}

// New returns a Limiter that refills at rate tokens per second and holds at
// most burst tokens. If clock is nil, RealClock is used.
func New(rate float64, burst int, clock Clock) *Limiter {
	if clock == nil {
		clock = RealClock{}
	}
	return &Limiter{clock: clock, rate: rate, burst: burst}
}

// Allow reports whether a token is available now, consuming it if so.
func (l *Limiter) Allow() bool {
	return false
}

// Wait blocks until a token is available and consumes it, or until ctx is done.
func (l *Limiter) Wait(ctx context.Context) error {
	return nil
}

// SetRate changes the refill rate.
func (l *Limiter) SetRate(rate float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rate = rate
}

// Burst returns the bucket capacity.
func (l *Limiter) Burst() int {
	return l.burst
}
