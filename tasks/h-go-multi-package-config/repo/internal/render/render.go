// Package render prints a configuration for humans (tool --print-config).
package render

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"example.com/hookrelay/internal/config"
)

// Redacted replaces the values of sensitive headers.
const Redacted = "<redacted>"

var sensitiveHeaders = map[string]bool{"authorization": true, "proxy-authorization": true, "x-api-key": true}

// Config writes cfg as "key = value" lines using the dotted JSON names, in the
// order documented in docs/configuration.md. Header values for credentials
// are redacted.
func Config(w io.Writer, cfg config.Config) error {
	lines := []string{
		line("listen_addr", cfg.ListenAddr),
		line("log.level", cfg.Log.Level),
		line("log.format", cfg.Log.Format),
		line("upstream.url", cfg.Upstream.URL),
		line("upstream.timeout_ms", cfg.Upstream.TimeoutMS),
	}
	lines = append(lines, headerLines(cfg.Upstream.Headers)...)
	lines = append(lines,
		line("queue.size", cfg.Queue.Size),
		line("queue.workers", cfg.Queue.Workers),
	)
	_, err := io.WriteString(w, strings.Join(lines, "\n")+"\n")
	return err
}

func line(key string, value any) string {
	return fmt.Sprintf("%s = %v", key, value)
}

func headerLines(headers map[string]string) []string {
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]string, 0, len(names))
	for _, name := range names {
		value := headers[name]
		if sensitiveHeaders[strings.ToLower(name)] {
			value = Redacted
		}
		out = append(out, line("upstream.headers."+name, value))
	}
	return out
}
