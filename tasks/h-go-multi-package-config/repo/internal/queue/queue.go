// Package queue is a bounded, goroutine-safe FIFO.
package queue

import (
	"errors"
	"sync"
)

// ErrFull is returned by Push when the queue is at capacity.
var ErrFull = errors.New("queue full")

// Queue holds up to Cap items.
type Queue[T any] struct {
	mu    sync.Mutex
	items []T
	cap   int
}

// New returns an empty queue holding at most capacity items.
func New[T any](capacity int) *Queue[T] {
	if capacity < 1 {
		capacity = 1
	}
	return &Queue[T]{cap: capacity}
}

// Push appends v, or returns ErrFull.
func (q *Queue[T]) Push(v T) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) >= q.cap {
		return ErrFull
	}
	q.items = append(q.items, v)
	return nil
}

// Pop removes and returns the oldest item; ok is false when empty.
func (q *Queue[T]) Pop() (v T, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return v, false
	}
	v = q.items[0]
	var zero T
	q.items[0] = zero
	q.items = q.items[1:]
	return v, true
}

// Len reports the number of queued items.
func (q *Queue[T]) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// Cap reports the capacity.
func (q *Queue[T]) Cap() int { return q.cap }
