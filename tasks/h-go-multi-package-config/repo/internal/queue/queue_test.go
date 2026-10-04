package queue

import (
	"errors"
	"testing"
)

func TestFIFO(t *testing.T) {
	q := New[int](3)
	for i := 1; i <= 3; i++ {
		if err := q.Push(i); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.Push(4); !errors.Is(err, ErrFull) {
		t.Fatalf("Push on full queue: %v", err)
	}
	for want := 1; want <= 3; want++ {
		got, ok := q.Pop()
		if !ok || got != want {
			t.Fatalf("Pop = %d, %v; want %d", got, ok, want)
		}
	}
	if _, ok := q.Pop(); ok {
		t.Fatal("Pop on empty queue succeeded")
	}
}

func TestMinimumCapacity(t *testing.T) {
	if New[string](0).Cap() != 1 {
		t.Fatal("capacity should be clamped to 1")
	}
}
