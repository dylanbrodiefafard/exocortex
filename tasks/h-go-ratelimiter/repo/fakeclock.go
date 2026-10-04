package ratelimit

import (
	"sync"
	"time"
)

// FakeClock is a manually advanced Clock for tests. Time only moves when
// Advance is called; timers whose deadline has been reached fire during
// Advance (or immediately in NewTimer if d <= 0).
type FakeClock struct {
	mu     sync.Mutex
	cond   *sync.Cond
	now    time.Time
	timers []*fakeTimer
}

// NewFakeClock returns a FakeClock whose current time is start.
func NewFakeClock(start time.Time) *FakeClock {
	c := &FakeClock{now: start}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *FakeClock) NewTimer(d time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{clock: c, deadline: c.now.Add(d), ch: make(chan time.Time, 1)}
	if d <= 0 {
		t.ch <- c.now
		return t
	}
	c.timers = append(c.timers, t)
	c.cond.Broadcast()
	return t
}

// Advance moves the clock forward by d and fires every pending timer whose
// deadline is at or before the new time.
func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	pending := c.timers[:0]
	for _, t := range c.timers {
		if !t.deadline.After(c.now) {
			t.ch <- c.now
			continue
		}
		pending = append(pending, t)
	}
	c.timers = pending
	c.cond.Broadcast()
}

// PendingTimers reports how many timers are waiting to fire.
func (c *FakeClock) PendingTimers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.timers)
}

// BlockUntil blocks until at least n timers are pending. Tests use it to know
// that a goroutine has started waiting before they advance the clock.
func (c *FakeClock) BlockUntil(n int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.timers) < n {
		c.cond.Wait()
	}
}

type fakeTimer struct {
	clock    *FakeClock
	deadline time.Time
	ch       chan time.Time
}

func (t *fakeTimer) C() <-chan time.Time { return t.ch }

func (t *fakeTimer) Stop() bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, p := range c.timers {
		if p == t {
			c.timers = append(c.timers[:i], c.timers[i+1:]...)
			c.cond.Broadcast()
			return true
		}
	}
	return false
}
