package app

import (
	"context"
	"sync"
	"time"
)

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	sleeps []time.Duration
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Sleep(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sleeps = append(c.sleeps, d)
	c.now = c.now.Add(d)
}

// scriptedSender returns the scripted responses in order, then repeats the last one.
type scriptedSender struct {
	mu       sync.Mutex
	script   []response
	requests []Request
}

type response struct {
	status int
	err    error
}

func (s *scriptedSender) Send(ctx context.Context, req Request) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := len(s.requests)
	s.requests = append(s.requests, req)
	if i >= len(s.script) {
		i = len(s.script) - 1
	}
	return s.script[i].status, s.script[i].err
}

func (s *scriptedSender) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}
