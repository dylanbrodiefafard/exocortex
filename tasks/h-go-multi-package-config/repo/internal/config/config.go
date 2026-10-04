// Package config defines hookrelay's configuration, how it is loaded from a
// JSON file and environment variables, and how it is validated.
//
// See docs/configuration.md for the user-facing description of every option.
package config

// Config is the complete runtime configuration.
type Config struct {
	ListenAddr string         `json:"listen_addr"`
	Log        LogConfig      `json:"log"`
	Upstream   UpstreamConfig `json:"upstream"`
	Queue      QueueConfig    `json:"queue"`
}

// LogConfig controls the logger.
type LogConfig struct {
	Level  string `json:"level"`  // debug, info, warn or error
	Format string `json:"format"` // text or json
}

// UpstreamConfig describes where deliveries are sent.
type UpstreamConfig struct {
	URL       string            `json:"url"`
	TimeoutMS int               `json:"timeout_ms"`
	Headers   map[string]string `json:"headers"`
}

// QueueConfig sizes the in-memory delivery queue.
type QueueConfig struct {
	Size    int `json:"size"`
	Workers int `json:"workers"`
}

// Default returns the configuration used when nothing overrides it.
func Default() Config {
	return Config{
		ListenAddr: ":8080",
		Log:        LogConfig{Level: "info", Format: "text"},
		Upstream: UpstreamConfig{
			URL:       "http://localhost:9000/hooks",
			TimeoutMS: 5000,
			Headers:   map[string]string{},
		},
		Queue: QueueConfig{Size: 1000, Workers: 4},
	}
}
