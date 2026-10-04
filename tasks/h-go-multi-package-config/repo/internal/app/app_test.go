package app

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strings"
	"testing"

	"example.com/hookrelay/internal/logging"
	"example.com/hookrelay/internal/queue"
)

func TestEnqueueRespectsQueueSize(t *testing.T) {
	cfg := testConfig()
	cfg.Queue.Size = 2
	a := New(cfg, &scriptedSender{script: []response{{status: 200}}}, WithClock(newFakeClock()))
	_ = a.Enqueue(Delivery{ID: "1"})
	_ = a.Enqueue(Delivery{ID: "2"})
	if err := a.Enqueue(Delivery{ID: "3"}); !errors.Is(err, queue.ErrFull) {
		t.Fatalf("got %v", err)
	}
	if a.Pending() != 2 {
		t.Fatalf("pending = %d", a.Pending())
	}
}

func TestDrainDeliversEverything(t *testing.T) {
	cfg := testConfig()
	cfg.Queue.Workers = 3
	var logs bytes.Buffer
	sender := &scriptedSender{script: []response{{status: 200}}}
	a := New(cfg, sender, WithClock(newFakeClock()), WithLogger(logging.New(&logs, logging.Info, "text")))
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if err := a.Enqueue(Delivery{ID: id}); err != nil {
			t.Fatal(err)
		}
	}
	results, err := a.Drain(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, r := range results {
		ids = append(ids, r.ID)
	}
	sort.Strings(ids)
	if strings.Join(ids, "") != "abcde" || a.Pending() != 0 {
		t.Fatalf("got %v", ids)
	}
	if strings.Count(logs.String(), `msg="delivered"`) != 5 {
		t.Fatalf("logs:\n%s", logs.String())
	}
}
