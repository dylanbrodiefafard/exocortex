package config

import (
	"errors"
	"strings"
	"testing"
)

func TestDefaultIsValid(t *testing.T) {
	if err := Validate(Default()); err != nil {
		t.Fatal(err)
	}
}

func TestValidationCollectsEveryProblem(t *testing.T) {
	cfg := Default()
	cfg.ListenAddr = " "
	cfg.Log.Level = "loud"
	cfg.Upstream.URL = "ftp://example.com"
	cfg.Upstream.TimeoutMS = 50
	cfg.Queue.Workers = 0
	err := Validate(cfg)
	var verr *ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("expected *ValidationError, got %v", err)
	}
	var fields []string
	for _, p := range verr.Problems {
		fields = append(fields, p.Field)
	}
	want := "listen_addr,log.level,upstream.url,upstream.timeout_ms,queue.workers"
	if got := strings.Join(fields, ","); got != want {
		t.Fatalf("fields = %s, want %s", got, want)
	}
}

func TestRangeMessage(t *testing.T) {
	cfg := Default()
	cfg.Queue.Size = 0
	err := Validate(cfg)
	if err == nil || !strings.Contains(err.Error(), "queue.size: must be between 1 and 100000, got 0") {
		t.Fatalf("got %v", err)
	}
}

func TestHeaderNames(t *testing.T) {
	cfg := Default()
	cfg.Upstream.Headers = map[string]string{"Bad Name": "x", "Good": "y"}
	err := Validate(cfg)
	if err == nil || !strings.Contains(err.Error(), `invalid header name "Bad Name"`) {
		t.Fatalf("got %v", err)
	}
}

func TestRelativeURLRejected(t *testing.T) {
	cfg := Default()
	cfg.Upstream.URL = "/hooks"
	var verr *ValidationError
	if !errors.As(Validate(cfg), &verr) || !verr.Has("upstream.url") {
		t.Fatal("expected upstream.url problem")
	}
}
