package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func noEnv(string) string { return "" }

func envMap(m map[string]string) Getenv {
	return func(k string) string { return m[k] }
}

func TestDefaultsWithoutFile(t *testing.T) {
	cfg, err := Load("", noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":8080" || cfg.Queue.Workers != 4 || cfg.Upstream.TimeoutMS != 5000 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	doc := `{
		"listen_addr": ":9090",
		"log": {"level": "debug"},
		"upstream": {"url": "https://hooks.example.com/in", "headers": {"X-Team": "core"}},
		"queue": {"workers": 8}
	}`
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":9090" || cfg.Log.Level != "debug" || cfg.Queue.Workers != 8 {
		t.Fatalf("file values not applied: %+v", cfg)
	}
	if cfg.Log.Format != "text" || cfg.Queue.Size != 1000 || cfg.Upstream.TimeoutMS != 5000 {
		t.Fatalf("omitted keys lost their defaults: %+v", cfg)
	}
	if cfg.Upstream.Headers["X-Team"] != "core" {
		t.Fatalf("headers not loaded: %+v", cfg.Upstream.Headers)
	}
}

func TestLoadRetrySection(t *testing.T) {
	cfg, err := Parse([]byte(`{"retry": {"max_attempts": 5, "backoff_ms": 50}}`), noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retry.MaxAttempts != 5 || cfg.Retry.BackoffMS != 50 {
		t.Fatalf("retry not loaded: %+v", cfg.Retry)
	}
}

func TestMissingFile(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.json"), noEnv); err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestUnknownKeyRejected(t *testing.T) {
	_, err := Parse([]byte(`{"queue": {"wokers": 2}}`), noEnv)
	if err == nil || !strings.Contains(err.Error(), "wokers") {
		t.Fatalf("expected unknown field error, got %v", err)
	}
}

func TestMalformedJSON(t *testing.T) {
	for _, doc := range []string{`{"listen_addr": }`, `{} {}`, `[]`} {
		if _, err := Parse([]byte(doc), noEnv); err == nil {
			t.Errorf("Parse(%s) succeeded", doc)
		}
	}
}

func TestEmptyDocumentMeansDefaults(t *testing.T) {
	cfg, err := Parse([]byte("  \n"), noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Log.Level != "info" {
		t.Fatalf("got %+v", cfg)
	}
}
