package ratelimit

import (
	"testing"
	"time"
)

var epoch = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

func allowN(l *Limiter, n int) int {
	got := 0
	for i := 0; i < n; i++ {
		if l.Allow() {
			got++
		}
	}
	return got
}

func TestAllowStartsFull(t *testing.T) {
	l := New(1, 3, NewFakeClock(epoch))
	if got := allowN(l, 5); got != 3 {
		t.Fatalf("allowed %d of 5 on a fresh limiter with burst 3, want 3", got)
	}
}

func TestAllowRefills(t *testing.T) {
	clk := NewFakeClock(epoch)
	l := New(2, 2, clk)
	allowN(l, 2)
	if l.Allow() {
		t.Fatal("Allow succeeded on an empty bucket")
	}
	clk.Advance(500 * time.Millisecond)
	if !l.Allow() {
		t.Fatal("Allow failed after one token's worth of refill")
	}
	if l.Allow() {
		t.Fatal("Allow succeeded twice after one token's worth of refill")
	}
}
