package app

import (
	"context"
	"errors"
	"testing"

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
