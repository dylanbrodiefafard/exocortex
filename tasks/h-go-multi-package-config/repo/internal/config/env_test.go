package config

import (
	"strings"
	"testing"
)

func TestEnvOverridesFile(t *testing.T) {
	env := envMap(map[string]string{
		"TOOL_LOG_LEVEL":           "warn",
		"TOOL_UPSTREAM_TIMEOUT_MS": " 2500 ",
		"TOOL_QUEUE_WORKERS":       "2",
	})
	cfg, err := Parse([]byte(`{"log": {"level": "debug"}, "queue": {"workers": 8}}`), env)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Log.Level != "warn" || cfg.Upstream.TimeoutMS != 2500 || cfg.Queue.Workers != 2 {
		t.Fatalf("env not applied: %+v", cfg)
	}
}

func TestEmptyEnvIsUnset(t *testing.T) {
	cfg, err := Parse(nil, envMap(map[string]string{"TOOL_LISTEN_ADDR": ""}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":8080" {
		t.Fatalf("got %q", cfg.ListenAddr)
	}
}

func TestBadIntegerNamesVariable(t *testing.T) {
	_, err := Parse(nil, envMap(map[string]string{"TOOL_QUEUE_SIZE": "lots"}))
	if err == nil || !strings.Contains(err.Error(), "TOOL_QUEUE_SIZE") {
		t.Fatalf("expected error naming TOOL_QUEUE_SIZE, got %v", err)
	}
}

func TestEnvValuesAreValidated(t *testing.T) {
	_, err := Parse(nil, envMap(map[string]string{"TOOL_LOG_FORMAT": "yaml"}))
	verr, ok := err.(*ValidationError)
	if !ok || !verr.Has("log.format") {
		t.Fatalf("expected log.format validation error, got %v", err)
	}
}

func TestEnvVarsListed(t *testing.T) {
	names := EnvVars()
	if len(names) == 0 || names[0] != "TOOL_LISTEN_ADDR" {
		t.Fatalf("got %v", names)
	}
}
