// Package app wires configuration, the delivery queue and the upstream client
// together.
package app

import (
	"context"
	"sync"

	"example.com/hookrelay/internal/config"
	"example.com/hookrelay/internal/logging"
	"example.com/hookrelay/internal/queue"
)

// App queues deliveries and forwards them upstream.
type App struct {
	cfg    config.Config
	client *Client
	queue  *queue.Queue[Delivery]
	log    *logging.Logger
	clock  Clock
}

// Option customises New.
type Option func(*App)

// WithClock replaces the wall clock (used for timing and waiting).
func WithClock(c Clock) Option { return func(a *App) { a.clock = c } }

// WithLogger replaces the default discarding logger.
func WithLogger(l *logging.Logger) Option { return func(a *App) { a.log = l } }

// New builds an App from a validated configuration.
func New(cfg config.Config, sender Sender, opts ...Option) *App {
	a := &App{cfg: cfg, log: logging.Discard(), clock: SystemClock}
	for _, opt := range opts {
		opt(a)
	}
	a.queue = queue.New[Delivery](cfg.Queue.Size)
	a.client = NewClient(cfg, sender, a.clock)
	return a
}

// Config returns the configuration the app was built with.
func (a *App) Config() config.Config { return a.cfg }

// Client returns the upstream client.
func (a *App) Client() *Client { return a.client }

// Enqueue adds d to the queue; it fails with queue.ErrFull when the queue is full.
func (a *App) Enqueue(d Delivery) error {
	if err := a.queue.Push(d); err != nil {
		a.log.Warn("dropped delivery", "id", d.ID, "reason", err)
		return err
	}
	return nil
}

// Pending reports how many deliveries are queued.
func (a *App) Pending() int { return a.queue.Len() }

// Drain delivers every queued item using queue.workers concurrent workers and
// returns the results in completion order. Failed deliveries are logged and
// included in the results; Drain itself only fails if ctx is cancelled.
func (a *App) Drain(ctx context.Context) ([]Result, error) {
	var (
		mu      sync.Mutex
		results []Result
		wg      sync.WaitGroup
	)
	for w := 0; w < a.cfg.Queue.Workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				d, ok := a.queue.Pop()
				if !ok {
					return
				}
				res, err := a.client.Deliver(ctx, d)
				if err != nil {
					a.log.Error("delivery failed", "id", d.ID, "attempts", res.Attempts, "err", err)
				} else {
					a.log.Info("delivered", "id", d.ID, "status", res.Status, "attempts", res.Attempts)
				}
				mu.Lock()
				results = append(results, res)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return results, ctx.Err()
}
