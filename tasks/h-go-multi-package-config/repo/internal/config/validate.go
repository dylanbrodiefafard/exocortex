package config

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// FieldError is one validation problem, keyed by the option's dotted JSON path.
type FieldError struct {
	Field string
	Msg   string
}

func (e FieldError) Error() string { return e.Field + ": " + e.Msg }

// ValidationError collects every problem found, in field order.
type ValidationError struct {
	Problems []FieldError
}

func (e *ValidationError) Error() string {
	parts := make([]string, len(e.Problems))
	for i, p := range e.Problems {
		parts[i] = p.Error()
	}
	return "invalid config: " + strings.Join(parts, "; ")
}

// Has reports whether field has a problem.
func (e *ValidationError) Has(field string) bool {
	for _, p := range e.Problems {
		if p.Field == field {
			return true
		}
	}
	return false
}

type checker struct{ problems []FieldError }

func (c *checker) fail(field, format string, args ...any) {
	c.problems = append(c.problems, FieldError{Field: field, Msg: fmt.Sprintf(format, args...)})
}

func (c *checker) intRange(field string, v, lo, hi int) {
	if v < lo || v > hi {
		c.fail(field, "must be between %d and %d, got %d", lo, hi, v)
	}
}

func (c *checker) oneOf(field, v string, allowed ...string) {
	for _, a := range allowed {
		if v == a {
			return
		}
	}
	c.fail(field, "must be one of %s, got %q", strings.Join(allowed, ", "), v)
}

// Validate returns a *ValidationError listing every problem, or nil.
func Validate(cfg Config) error {
	var c checker
	if strings.TrimSpace(cfg.ListenAddr) == "" {
		c.fail("listen_addr", "must not be empty")
	}
	c.oneOf("log.level", cfg.Log.Level, "debug", "info", "warn", "error")
	c.oneOf("log.format", cfg.Log.Format, "text", "json")
	if u, err := url.Parse(cfg.Upstream.URL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		c.fail("upstream.url", "must be an absolute http or https URL, got %q", cfg.Upstream.URL)
	}
	c.intRange("upstream.timeout_ms", cfg.Upstream.TimeoutMS, 100, 120000)
	names := make([]string, 0, len(cfg.Upstream.Headers))
	for name := range cfg.Upstream.Headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if strings.TrimSpace(name) == "" || strings.ContainsAny(name, " :\r\n") {
			c.fail("upstream.headers", "invalid header name %q", name)
		}
	}
	c.intRange("queue.size", cfg.Queue.Size, 1, 100000)
	c.intRange("queue.workers", cfg.Queue.Workers, 1, 64)
	if len(c.problems) > 0 {
		return &ValidationError{Problems: c.problems}
	}
	return nil
}
