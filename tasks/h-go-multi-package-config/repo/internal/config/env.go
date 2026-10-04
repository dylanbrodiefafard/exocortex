package config

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// envOverride maps one environment variable onto one config field.
type envOverride struct {
	name  string
	apply func(cfg *Config, value string) error
}

func stringField(field func(*Config) *string) func(*Config, string) error {
	return func(cfg *Config, value string) error {
		*field(cfg) = value
		return nil
	}
}

func intField(field func(*Config) *int) func(*Config, string) error {
	return func(cfg *Config, value string) error {
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf("invalid integer %q", value)
		}
		*field(cfg) = n
		return nil
	}
}

var envOverrides = []envOverride{
	{"TOOL_LISTEN_ADDR", stringField(func(c *Config) *string { return &c.ListenAddr })},
	{"TOOL_LOG_LEVEL", stringField(func(c *Config) *string { return &c.Log.Level })},
	{"TOOL_LOG_FORMAT", stringField(func(c *Config) *string { return &c.Log.Format })},
	{"TOOL_UPSTREAM_URL", stringField(func(c *Config) *string { return &c.Upstream.URL })},
	{"TOOL_UPSTREAM_TIMEOUT_MS", intField(func(c *Config) *int { return &c.Upstream.TimeoutMS })},
	{"TOOL_QUEUE_SIZE", intField(func(c *Config) *int { return &c.Queue.Size })},
	{"TOOL_QUEUE_WORKERS", intField(func(c *Config) *int { return &c.Queue.Workers })},
}

// EnvVars lists the environment variables Load understands, sorted.
func EnvVars() []string {
	names := make([]string, 0, len(envOverrides))
	for _, o := range envOverrides {
		names = append(names, o.name)
	}
	sort.Strings(names)
	return names
}

// applyEnv applies every set, non-empty override. An empty variable counts as
// unset. The first malformed value aborts with an error naming the variable.
func applyEnv(cfg *Config, getenv Getenv) error {
	for _, o := range envOverrides {
		value := getenv(o.name)
		if value == "" {
			continue
		}
		if err := o.apply(cfg, value); err != nil {
			return fmt.Errorf("env %s: %w", o.name, err)
		}
	}
	return nil
}
