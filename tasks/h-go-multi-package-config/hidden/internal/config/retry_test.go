package config

import (
	"errors"
	"strings"
	"testing"
)

func TestRetryDefaults(t *testing.T) {
	if d := Default().Retry; d.MaxAttempts != 3 || d.BackoffMS != 200 {
		t.Fatalf("Default().Retry = %+v", d)
	}
	cfg, err := Parse(nil, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retry.MaxAttempts != 3 || cfg.Retry.BackoffMS != 200 {
		t.Fatalf("got %+v", cfg.Retry)
	}
}

func TestRetryPartialSectionKeepsDefaults(t *testing.T) {
	cfg, err := Parse([]byte(`{"retry": {"max_attempts": 6}}`), noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retry.MaxAttempts != 6 || cfg.Retry.BackoffMS != 200 {
		t.Fatalf("got %+v", cfg.Retry)
	}
	cfg, err = Parse([]byte(`{"retry": {"backoff_ms": 0}}`), noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retry.MaxAttempts != 3 || cfg.Retry.BackoffMS != 0 {
		t.Fatalf("explicit zero backoff not kept: %+v", cfg.Retry)
	}
}

func TestRetryUnknownKeyRejected(t *testing.T) {
	if _, err := Parse([]byte(`{"retry": {"attempts": 2}}`), noEnv); err == nil {
		t.Fatal("expected unknown field error")
	}
}

func TestRetryEnvOverrides(t *testing.T) {
	env := envMap(map[string]string{"TOOL_RETRY_MAX_ATTEMPTS": " 7 ", "TOOL_RETRY_BACKOFF_MS": "1500"})
	cfg, err := Parse([]byte(`{"retry": {"max_attempts": 2, "backoff_ms": 10}}`), env)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retry.MaxAttempts != 7 || cfg.Retry.BackoffMS != 1500 {
		t.Fatalf("got %+v", cfg.Retry)
	}
}

func TestRetryEnvEmptyIsUnset(t *testing.T) {
	env := envMap(map[string]string{"TOOL_RETRY_MAX_ATTEMPTS": "", "TOOL_RETRY_BACKOFF_MS": ""})
	cfg, err := Parse([]byte(`{"retry": {"max_attempts": 2}}`), env)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retry.MaxAttempts != 2 || cfg.Retry.BackoffMS != 200 {
		t.Fatalf("got %+v", cfg.Retry)
	}
}

func TestRetryEnvBadInteger(t *testing.T) {
	for _, name := range []string{"TOOL_RETRY_MAX_ATTEMPTS", "TOOL_RETRY_BACKOFF_MS"} {
		_, err := Parse(nil, envMap(map[string]string{name: "1.5"}))
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=1.5: expected error naming the variable, got %v", name, err)
		}
	}
}

func TestRetryEnvVarsListed(t *testing.T) {
	names := strings.Join(EnvVars(), ",")
	for _, want := range []string{"TOOL_RETRY_MAX_ATTEMPTS", "TOOL_RETRY_BACKOFF_MS"} {
		if !strings.Contains(names, want) {
			t.Errorf("EnvVars() missing %s: %s", want, names)
		}
	}
}

func TestRetryValidationRanges(t *testing.T) {
	valid := []RetryConfig{{1, 0}, {10, 60000}, {3, 200}}
	for _, r := range valid {
		cfg := Default()
		cfg.Retry = r
		if err := Validate(cfg); err != nil {
			t.Errorf("%+v: unexpected error %v", r, err)
		}
	}
	cases := []struct {
		retry RetryConfig
		msg   string
	}{
		{RetryConfig{0, 200}, "retry.max_attempts: must be between 1 and 10, got 0"},
		{RetryConfig{11, 200}, "retry.max_attempts: must be between 1 and 10, got 11"},
		{RetryConfig{3, -1}, "retry.backoff_ms: must be between 0 and 60000, got -1"},
		{RetryConfig{3, 60001}, "retry.backoff_ms: must be between 0 and 60000, got 60001"},
	}
	for _, c := range cases {
		cfg := Default()
		cfg.Retry = c.retry
		err := Validate(cfg)
		var verr *ValidationError
		if !errors.As(err, &verr) || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("%+v: got %v, want %q", c.retry, err, c.msg)
		}
	}
}

func TestRetryValidationReportsBoth(t *testing.T) {
	cfg := Default()
	cfg.Retry = RetryConfig{MaxAttempts: -2, BackoffMS: 999999}
	err := Validate(cfg)
	var verr *ValidationError
	if !errors.As(err, &verr) || !verr.Has("retry.max_attempts") || !verr.Has("retry.backoff_ms") {
		t.Fatalf("got %v", err)
	}
}

func TestRetryValidationAppliesToFileAndEnv(t *testing.T) {
	_, err := Parse([]byte(`{"retry": {"max_attempts": 0}}`), noEnv)
	var verr *ValidationError
	if !errors.As(err, &verr) || !verr.Has("retry.max_attempts") {
		t.Fatalf("file: got %v", err)
	}
	_, err = Parse(nil, envMap(map[string]string{"TOOL_RETRY_BACKOFF_MS": "-5"}))
	if !errors.As(err, &verr) || !verr.Has("retry.backoff_ms") {
		t.Fatalf("env: got %v", err)
	}
}
