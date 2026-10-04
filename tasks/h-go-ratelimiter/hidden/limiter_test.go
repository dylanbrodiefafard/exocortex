package ratelimit

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var epoch = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

// guard bounds how long a test waits (in real time) for a goroutine that a
// correct implementation unblocks immediately.
const guard = 5 * time.Second

func allowN(l *Limiter, n int) int {
	got := 0
	for i := 0; i < n; i++ {
		if l.Allow() {
			got++
		}
	}
	return got
}

func drained(t *testing.T, rate float64, burst int) (*Limiter, *FakeClock) {
	t.Helper()
	clk := NewFakeClock(epoch)
	l := New(rate, burst, clk)
	if got := allowN(l, burst); got != burst {
		t.Fatalf("fresh limiter allowed %d, want burst %d", got, burst)
	}
	if l.Allow() {
		t.Fatal("Allow succeeded on an empty bucket")
	}
	return l, clk
}

func startWait(ctx context.Context, l *Limiter) <-chan error {
	ch := make(chan error, 1)
	go func() { ch <- l.Wait(ctx) }()
	return ch
}

func result(t *testing.T, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(guard):
		t.Fatal("Wait did not return")
		return nil
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(guard)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// waitForTimers is a bounded BlockUntil: it fails the test instead of hanging
// if no goroutine ever starts waiting.
func waitForTimers(t *testing.T, clk *FakeClock, n int) {
	t.Helper()
	eventually(t, "Wait to start a timer", func() bool { return clk.PendingTimers() >= n })
}

func expectPanic(t *testing.T, name string, f func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Errorf("%s did not panic", name)
		}
	}()
	f()
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

func TestBurstCap(t *testing.T) {
	l, clk := drained(t, 4, 2)
	clk.Advance(10 * time.Second)
	if got := allowN(l, 5); got != 2 {
		t.Fatalf("after a long idle period allowed %d, want burst 2", got)
	}
	clk.Advance(time.Hour)
	if got := allowN(l, 5); got != 2 {
		t.Fatalf("after an hour idle allowed %d, want burst 2", got)
	}
}

func TestFractionalRate(t *testing.T) {
	l, clk := drained(t, 0.5, 1)
	clk.Advance(time.Second)
	if l.Allow() {
		t.Fatal("rate 0.5: Allow succeeded after 1s (only half a token)")
	}
	clk.Advance(time.Second)
	if !l.Allow() {
		t.Fatal("rate 0.5: Allow failed after 2s")
	}
}

func TestFractionalTokensAccumulateAcrossCalls(t *testing.T) {
	l, clk := drained(t, 3, 5)
	var got []int
	for step := 1; step <= 9; step++ {
		clk.Advance(100 * time.Millisecond)
		if l.Allow() {
			got = append(got, step)
		}
	}
	if len(got) != 2 || got[0] != 4 || got[1] != 7 {
		t.Fatalf("rate 3, Allow every 100ms: succeeded at steps %v, want [4 7]", got)
	}
}

func TestAllowDoesNotConsumeOnFailure(t *testing.T) {
	l, clk := drained(t, 1, 1)
	clk.Advance(600 * time.Millisecond)
	if l.Allow() {
		t.Fatal("Allow succeeded with 0.6 tokens")
	}
	clk.Advance(400 * time.Millisecond)
	if !l.Allow() {
		t.Fatal("failed Allow lost the partial token")
	}
}

func TestNewPanicsOnInvalidArgs(t *testing.T) {
	clk := NewFakeClock(epoch)
	expectPanic(t, "New(0, 1)", func() { New(0, 1, clk) })
	expectPanic(t, "New(-1, 1)", func() { New(-1, 1, clk) })
	expectPanic(t, "New(1, 0)", func() { New(1, 0, clk) })
}

func TestNilClockUsesRealClock(t *testing.T) {
	l := New(1, 1, nil)
	if !l.Allow() {
		t.Fatal("fresh limiter with nil clock refused a token")
	}
}

func TestWaitImmediateWhenTokenAvailable(t *testing.T) {
	clk := NewFakeClock(epoch)
	l := New(1, 2, clk)
	if err := result(t, startWait(context.Background(), l)); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if got := allowN(l, 3); got != 1 {
		t.Fatalf("after one Wait, Allow succeeded %d times, want 1", got)
	}
	if n := clk.PendingTimers(); n != 0 {
		t.Fatalf("%d timers pending after Wait returned", n)
	}
}

func TestWaitBlocksUntilRefill(t *testing.T) {
	l, clk := drained(t, 4, 1)
	done := startWait(context.Background(), l)
	waitForTimers(t, clk, 1)
	clk.Advance(251 * time.Millisecond)
	if err := result(t, done); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if l.Allow() {
		t.Fatal("Wait did not consume the token it waited for")
	}
}

func TestWaitDoesNotReturnEarly(t *testing.T) {
	l, clk := drained(t, 4, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := startWait(ctx, l)
	waitForTimers(t, clk, 1)
	clk.Advance(200 * time.Millisecond)
	eventually(t, "a pending timer after a partial refill", func() bool { return clk.PendingTimers() == 1 })
	select {
	case err := <-done:
		t.Fatalf("Wait returned %v with only 0.8 tokens available", err)
	default:
	}
	clk.Advance(51 * time.Millisecond)
	if err := result(t, done); err != nil {
		t.Fatalf("Wait: %v", err)
	}
}

func TestWaitCancelReturnsCtxErrAndKeepsTokens(t *testing.T) {
	l, clk := drained(t, 1, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := startWait(ctx, l)
	waitForTimers(t, clk, 1)
	clk.Advance(500 * time.Millisecond)
	cancel()
	if err := result(t, done); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait after cancel returned %v, want context.Canceled", err)
	}
	if n := clk.PendingTimers(); n != 0 {
		t.Fatalf("cancelled Wait left %d timers pending", n)
	}
	if l.Allow() {
		t.Fatal("Allow succeeded with only 0.5 tokens")
	}
	clk.Advance(500 * time.Millisecond)
	if !l.Allow() {
		t.Fatal("cancelled Wait consumed (or reserved) a token")
	}
	if l.Allow() {
		t.Fatal("Allow succeeded twice")
	}
}

func TestWaitAlreadyCancelled(t *testing.T) {
	clk := NewFakeClock(epoch)
	l := New(1, 2, clk)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := result(t, startWait(ctx, l)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait with a cancelled ctx returned %v, want context.Canceled", err)
	}
	if got := allowN(l, 3); got != 2 {
		t.Fatalf("Wait with a cancelled ctx consumed a token: Allow succeeded %d times, want 2", got)
	}
}

func TestWaitAlreadyCancelledEmptyBucket(t *testing.T) {
	l, clk := drained(t, 1, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := result(t, startWait(ctx, l)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait returned %v, want context.Canceled", err)
	}
	clk.Advance(time.Second)
	if !l.Allow() {
		t.Fatal("cancelled Wait consumed a token")
	}
}

func TestSetRateKeepsAccruedTokens(t *testing.T) {
	l, clk := drained(t, 1, 10)
	clk.Advance(500 * time.Millisecond)
	l.SetRate(4)
	if l.Allow() {
		t.Fatal("SetRate re-credited past time at the new rate (0.5 accrued, Allow should fail)")
	}
	clk.Advance(125 * time.Millisecond)
	if !l.Allow() {
		t.Fatal("SetRate lost the tokens accrued before the change (0.5 + 4*0.125 = 1)")
	}
}

func TestSetRateSlowerKeepsAccruedTokens(t *testing.T) {
	l, clk := drained(t, 4, 10)
	clk.Advance(time.Second)
	l.SetRate(0.5)
	if got := allowN(l, 10); got != 4 {
		t.Fatalf("after SetRate, Allow succeeded %d times, want the 4 tokens accrued before", got)
	}
	clk.Advance(time.Second)
	if l.Allow() {
		t.Fatal("refill still runs at the old rate after SetRate")
	}
	clk.Advance(time.Second)
	if !l.Allow() {
		t.Fatal("refill not running at the new rate after SetRate")
	}
}

func TestSetRateKeepsFullBucket(t *testing.T) {
	clk := NewFakeClock(epoch)
	l := New(1, 3, clk)
	l.SetRate(2)
	if got := allowN(l, 5); got != 3 {
		t.Fatalf("SetRate on a full bucket: Allow succeeded %d times, want 3", got)
	}
}

func TestSetRatePanicsOnInvalidRate(t *testing.T) {
	l := New(1, 1, NewFakeClock(epoch))
	expectPanic(t, "SetRate(0)", func() { l.SetRate(0) })
	expectPanic(t, "SetRate(-2)", func() { l.SetRate(-2) })
}

func TestConcurrentAllow(t *testing.T) {
	clk := NewFakeClock(epoch)
	l := New(1, 50, clk)
	var granted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.Allow() {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()
	if got := granted.Load(); got != 50 {
		t.Fatalf("200 concurrent Allow calls with burst 50 granted %d", got)
	}
}

func TestConcurrentWaitersEachGetOneToken(t *testing.T) {
	const waiters = 5
	l, clk := drained(t, 1, 1)
	var finished atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, waiters)
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := l.Wait(context.Background()); err != nil {
				errs <- err
				return
			}
			finished.Add(1)
		}()
	}
	waitForTimers(t, clk, waiters)
	for k := 1; k <= waiters; k++ {
		clk.Advance(time.Second)
		want := int64(k)
		eventually(t, "one more waiter to finish per refilled token", func() bool {
			return finished.Load() == want && clk.PendingTimers() == waiters-k
		})
		if got := finished.Load(); got != want {
			t.Fatalf("after %d tokens refilled, %d waiters finished", k, got)
		}
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("Wait: %v", err)
	}
	if l.Allow() {
		t.Fatal("token left over after all waiters were served")
	}
}

func TestConcurrentMixedUse(t *testing.T) {
	clk := NewFakeClock(epoch)
	l := New(1000, 100, clk)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				switch (i + j) % 3 {
				case 0:
					l.Allow()
				case 1:
					l.SetRate(float64(500 + j))
				default:
					wctx, wcancel := context.WithCancel(ctx)
					wcancel()
					_ = l.Wait(wctx)
				}
			}
		}(i)
	}
	wg.Wait()
}
