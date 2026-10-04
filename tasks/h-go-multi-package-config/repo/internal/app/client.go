package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"example.com/hookrelay/internal/config"
)

var (
	// ErrUpstream means the upstream failed (transport error or 5xx status).
	ErrUpstream = errors.New("upstream failed")
	// ErrRejected means the upstream refused the delivery (4xx status).
	ErrRejected = errors.New("upstream rejected delivery")
)

// Delivery is one webhook payload to forward.
type Delivery struct {
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload"`
}

// Request is what a Sender puts on the wire.
type Request struct {
	URL     string
	Headers map[string]string
	Body    []byte
}

// Sender performs one HTTP POST and reports the response status.
type Sender interface {
	Send(ctx context.Context, req Request) (status int, err error)
}

// SenderFunc adapts a function to Sender.
type SenderFunc func(ctx context.Context, req Request) (int, error)

func (f SenderFunc) Send(ctx context.Context, req Request) (int, error) { return f(ctx, req) }

// Result describes the outcome of Deliver.
type Result struct {
	ID       string
	Status   int // last HTTP status seen, 0 if none
	Attempts int
	Duration time.Duration
}

// Client forwards deliveries to the configured upstream.
type Client struct {
	upstream config.UpstreamConfig
	sender   Sender
	clock    Clock
}

// NewClient returns a client for cfg's upstream.
func NewClient(cfg config.Config, sender Sender, clock Clock) *Client {
	if clock == nil {
		clock = SystemClock
	}
	return &Client{upstream: cfg.Upstream, sender: sender, clock: clock}
}

// Deliver sends d upstream. Each attempt is bounded by upstream.timeout_ms.
// It returns an error wrapping ErrUpstream or ErrRejected on failure.
func (c *Client) Deliver(ctx context.Context, d Delivery) (Result, error) {
	start := c.clock.Now()
	res := Result{ID: d.ID}
	status, err := c.attempt(ctx, d)
	res.Attempts = 1
	res.Status = status
	res.Duration = c.clock.Now().Sub(start)
	return res, classify(status, err)
}

func (c *Client) attempt(ctx context.Context, d Delivery) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(c.upstream.TimeoutMS)*time.Millisecond)
	defer cancel()
	headers := map[string]string{"Content-Type": "application/json", "X-Delivery-ID": d.ID}
	for k, v := range c.upstream.Headers {
		headers[k] = v
	}
	return c.sender.Send(ctx, Request{URL: c.upstream.URL, Headers: headers, Body: d.Payload})
}

func classify(status int, err error) error {
	switch {
	case err != nil:
		return fmt.Errorf("%w: %v", ErrUpstream, err)
	case status >= 500:
		return fmt.Errorf("%w: status %d", ErrUpstream, status)
	case status >= 400:
		return fmt.Errorf("%w: status %d", ErrRejected, status)
	default:
		return nil
	}
}
