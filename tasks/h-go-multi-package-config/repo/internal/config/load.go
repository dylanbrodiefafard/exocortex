package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
)

// Getenv looks up an environment variable; os.Getenv satisfies it. Tests pass
// a map-backed function instead.
type Getenv func(string) string

// Load builds the configuration: defaults, then the JSON file at path (if path
// is not empty), then environment overrides. The result is validated.
func Load(path string, getenv Getenv) (Config, error) {
	var data []byte
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return Config{}, fmt.Errorf("read config: %w", err)
		}
		data = b
	}
	return Parse(data, getenv)
}

// Parse is Load for an in-memory JSON document. Empty data means "no file".
func Parse(data []byte, getenv Getenv) (Config, error) {
	cfg := Default()
	if len(bytes.TrimSpace(data)) > 0 {
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&cfg); err != nil {
			return Config{}, fmt.Errorf("parse config: %w", err)
		}
		if dec.More() {
			return Config{}, fmt.Errorf("parse config: trailing data after JSON object")
		}
	}
	if cfg.Upstream.Headers == nil {
		cfg.Upstream.Headers = map[string]string{}
	}
	if getenv != nil {
		if err := applyEnv(&cfg, getenv); err != nil {
			return Config{}, err
		}
	}
	if err := Validate(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}
