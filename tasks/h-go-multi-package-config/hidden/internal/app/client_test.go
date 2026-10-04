package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"example.com/hookrelay/internal/config"
)

func testConfig() config.Config {
	cfg := config.Default()
	cfg.Upstream.URL = "https://hooks.example.com/in"
	cfg.Upstream.Headers = map[string]string{"X-Team": "core"}
	return cfg
}

func TestDeliverSuccess(t *testing.T) {
	sender := &scriptedSender{script: []response{{status: 202}}}
	c := NewClient(testConfig(), sender, newFakeClock())
	res, err := c.Deliver(context.Background(), Delivery{ID: "d1", Payload: []byte(`{"a":1}`)})
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "d1" || res.Status != 202 || res.Attempts != 1 {
		t.Fatalf("got %+v", res)
	}
	req := sender.requests[0]
	if req.URL != "https://hooks.example.com/in" || string(req.Body) != `{"a":1}` {
		t.Fatalf("bad request %+v", req)
	}
	if req.Headers["X-Delivery-ID"] != "d1" || req.Headers["X-Team"] != "core" || req.Headers["Content-Type"] != "application/json" {
		t.Fatalf("bad headers %v", req.Headers)
	}
}

func TestDeliverRejected(t *testing.T) {
	sender := &scriptedSender{script: []response{{status: 422}}}
	res, err := NewClient(testConfig(), sender, newFakeClock()).Deliver(context.Background(), Delivery{ID: "d2"})
	if !errors.Is(err, ErrRejected) || res.Status != 422 {
		t.Fatalf("got %+v, %v", res, err)
	}
}

func TestDeliverTransportError(t *testing.T) {
	sender := &scriptedSender{script: []response{{err: errors.New("connection refused")}}}
	_, err := NewClient(testConfig(), sender, newFakeClock()).Deliver(context.Background(), Delivery{ID: "d3"})
	if !errors.Is(err, ErrUpstream) {
		t.Fatalf("got %v", err)
	}
}

func retryConfig(maxAttempts, backoffMS int) config.Config {
	cfg := testConfig()
	cfg.Retry = config.RetryConfig{MaxAttempts: maxAttempts, BackoffMS: backoffMS}
	return cfg
}

func ms(values ...int) []time.Duration {
	out := make([]time.Duration, len(values))
	for i, v := range values {
		out[i] = time.Duration(v) * time.Millisecond
	}
	return out
}

func sameDurations(a, b []time.Duration) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRetryUntilSuccess(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 503}, {status: 502}, {status: 200}}}
	res, err := NewClient(retryConfig(3, 200), sender, clock).Deliver(context.Background(), Delivery{ID: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Attempts != 3 || res.Status != 200 || sender.calls() != 3 {
		t.Fatalf("got %+v after %d calls", res, sender.calls())
	}
	if !sameDurations(clock.sleeps, ms(200, 400)) {
		t.Fatalf("sleeps = %v, want [200ms 400ms]", clock.sleeps)
	}
}

func TestRetryDefaultsFromConfig(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 500}}}
	res, err := NewClient(testConfig(), sender, clock).Deliver(context.Background(), Delivery{ID: "r0"})
	if !errors.Is(err, ErrUpstream) || res.Attempts != 3 || sender.calls() != 3 {
		t.Fatalf("got %+v, %v after %d calls", res, err, sender.calls())
	}
	if !sameDurations(clock.sleeps, ms(200, 400)) {
		t.Fatalf("sleeps = %v", clock.sleeps)
	}
}

func TestRetryExhausted(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 500}}}
	res, err := NewClient(retryConfig(4, 100), sender, clock).Deliver(context.Background(), Delivery{ID: "r2"})
	if !errors.Is(err, ErrUpstream) {
		t.Fatalf("got %v", err)
	}
	if res.Attempts != 4 || res.Status != 500 || sender.calls() != 4 {
		t.Fatalf("got %+v after %d calls", res, sender.calls())
	}
	if !sameDurations(clock.sleeps, ms(100, 200, 400)) {
		t.Fatalf("sleeps = %v, want [100ms 200ms 400ms]", clock.sleeps)
	}
}

func TestRetryTransportErrors(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{err: errors.New("reset")}, {status: 204}}}
	res, err := NewClient(retryConfig(5, 50), sender, clock).Deliver(context.Background(), Delivery{ID: "r3"})
	if err != nil || res.Attempts != 2 || res.Status != 204 {
		t.Fatalf("got %+v, %v", res, err)
	}
	if !sameDurations(clock.sleeps, ms(50)) {
		t.Fatalf("sleeps = %v", clock.sleeps)
	}
}

func TestRejectedIsNotRetried(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 400}, {status: 200}}}
	res, err := NewClient(retryConfig(5, 50), sender, clock).Deliver(context.Background(), Delivery{ID: "r4"})
	if !errors.Is(err, ErrRejected) || res.Attempts != 1 || sender.calls() != 1 || len(clock.sleeps) != 0 {
		t.Fatalf("got %+v, %v, calls %d, sleeps %v", res, err, sender.calls(), clock.sleeps)
	}
}

func TestRejectedAfterRetryStops(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 503}, {status: 409}, {status: 200}}}
	res, err := NewClient(retryConfig(5, 10), sender, clock).Deliver(context.Background(), Delivery{ID: "r5"})
	if !errors.Is(err, ErrRejected) || res.Attempts != 2 || res.Status != 409 || sender.calls() != 2 {
		t.Fatalf("got %+v, %v, calls %d", res, err, sender.calls())
	}
}

func TestSingleAttempt(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 503}}}
	res, err := NewClient(retryConfig(1, 500), sender, clock).Deliver(context.Background(), Delivery{ID: "r6"})
	if !errors.Is(err, ErrUpstream) || res.Attempts != 1 || sender.calls() != 1 || len(clock.sleeps) != 0 {
		t.Fatalf("got %+v, %v, calls %d, sleeps %v", res, err, sender.calls(), clock.sleeps)
	}
}

func TestZeroBackoff(t *testing.T) {
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 503}, {status: 503}, {status: 201}}}
	res, err := NewClient(retryConfig(3, 0), sender, clock).Deliver(context.Background(), Delivery{ID: "r7"})
	if err != nil || res.Attempts != 3 {
		t.Fatalf("got %+v, %v", res, err)
	}
	var total time.Duration
	for _, d := range clock.sleeps {
		total += d
	}
	if total != 0 {
		t.Fatalf("waited %v with zero backoff", total)
	}
}

func TestContextCancelledStopsRetries(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	sender := SenderFunc(func(context.Context, Request) (int, error) {
		calls++
		cancel()
		return 503, nil
	})
	res, err := NewClient(retryConfig(5, 100), sender, newFakeClock()).Deliver(ctx, Delivery{ID: "r8"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if calls != 1 || res.Attempts != 1 {
		t.Fatalf("calls = %d, attempts = %d", calls, res.Attempts)
	}
}

func TestAppClientUsesRetryConfigAndClock(t *testing.T) {
	cfg := retryConfig(2, 300)
	cfg.Queue.Workers = 1
	clock := newFakeClock()
	sender := &scriptedSender{script: []response{{status: 500}}}
	a := New(cfg, sender, WithClock(clock))
	_ = a.Enqueue(Delivery{ID: "x"})
	_ = a.Enqueue(Delivery{ID: "y"})
	results, err := a.Drain(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if r.Attempts != 2 {
			t.Fatalf("got %+v", r)
		}
	}
	if sender.calls() != 4 || !sameDurations(clock.sleeps, ms(300, 300)) {
		t.Fatalf("calls %d, sleeps %v", sender.calls(), clock.sleeps)
	}
}
