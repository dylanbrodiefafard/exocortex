// Package logging is a small leveled logger with text and JSON output.
package logging

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
)

// Level orders log severities.
type Level int

const (
	Debug Level = iota
	Info
	Warn
	Error
)

var levelNames = map[Level]string{Debug: "debug", Info: "info", Warn: "warn", Error: "error"}

// ParseLevel converts "debug", "info", "warn" or "error" into a Level.
func ParseLevel(s string) (Level, error) {
	for l, name := range levelNames {
		if name == strings.ToLower(s) {
			return l, nil
		}
	}
	return Info, fmt.Errorf("unknown log level %q", s)
}

func (l Level) String() string { return levelNames[l] }

// Logger writes one line per record. It is safe for concurrent use.
type Logger struct {
	mu     sync.Mutex
	w      io.Writer
	level  Level
	asJSON bool
}

// New returns a logger writing records at or above level to w.
func New(w io.Writer, level Level, format string) *Logger {
	return &Logger{w: w, level: level, asJSON: format == "json"}
}

// Discard returns a logger that drops everything.
func Discard() *Logger { return New(io.Discard, Error+1, "text") }

// Log writes msg with key/value pairs; kv must have an even length.
func (l *Logger) Log(level Level, msg string, kv ...any) {
	if level < l.level {
		return
	}
	fields := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		fields[fmt.Sprint(kv[i])] = kv[i+1]
	}
	var line string
	if l.asJSON {
		fields["level"] = level.String()
		fields["msg"] = msg
		b, _ := json.Marshal(fields)
		line = string(b)
	} else {
		keys := make([]string, 0, len(fields))
		for k := range fields {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var sb strings.Builder
		fmt.Fprintf(&sb, "level=%s msg=%q", level, msg)
		for _, k := range keys {
			fmt.Fprintf(&sb, " %s=%v", k, fields[k])
		}
		line = sb.String()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintln(l.w, line)
}

func (l *Logger) Debug(msg string, kv ...any) { l.Log(Debug, msg, kv...) }
func (l *Logger) Info(msg string, kv ...any)  { l.Log(Info, msg, kv...) }
func (l *Logger) Warn(msg string, kv ...any)  { l.Log(Warn, msg, kv...) }
func (l *Logger) Error(msg string, kv ...any) { l.Log(Error, msg, kv...) }
