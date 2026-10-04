package logging

import (
	"bytes"
	"testing"
)

func TestTextFormat(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, Info, "text")
	l.Info("delivered", "status", 200, "id", "a1")
	l.Debug("hidden")
	want := "level=info msg=\"delivered\" id=a1 status=200\n"
	if buf.String() != want {
		t.Fatalf("got %q, want %q", buf.String(), want)
	}
}

func TestJSONFormat(t *testing.T) {
	var buf bytes.Buffer
	New(&buf, Debug, "json").Warn("slow", "ms", 12)
	want := `{"level":"warn","ms":12,"msg":"slow"}` + "\n"
	if buf.String() != want {
		t.Fatalf("got %q, want %q", buf.String(), want)
	}
}

func TestParseLevel(t *testing.T) {
	for in, want := range map[string]Level{"debug": Debug, "INFO": Info, "warn": Warn, "error": Error} {
		got, err := ParseLevel(in)
		if err != nil || got != want {
			t.Errorf("ParseLevel(%q) = %v, %v", in, got, err)
		}
	}
	if _, err := ParseLevel("loud"); err == nil {
		t.Error("expected error for unknown level")
	}
}
