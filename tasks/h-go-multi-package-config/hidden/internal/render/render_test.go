package render

import (
	"strings"
	"testing"

	"example.com/hookrelay/internal/config"
)

func TestDefaults(t *testing.T) {
	var sb strings.Builder
	if err := Config(&sb, config.Default()); err != nil {
		t.Fatal(err)
	}
	want := `listen_addr = :8080
log.level = info
log.format = text
upstream.url = http://localhost:9000/hooks
upstream.timeout_ms = 5000
retry.max_attempts = 3
retry.backoff_ms = 200
queue.size = 1000
queue.workers = 4
`
	if sb.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", sb.String(), want)
	}
}

func TestHeadersSortedAndRedacted(t *testing.T) {
	cfg := config.Default()
	cfg.Upstream.Headers = map[string]string{"X-Team": "core", "Authorization": "Bearer s3cret", "x-api-key": "k"}
	var sb strings.Builder
	if err := Config(&sb, cfg); err != nil {
		t.Fatal(err)
	}
	out := sb.String()
	if strings.Contains(out, "s3cret") || strings.Contains(out, "= k\n") {
		t.Fatalf("secret leaked:\n%s", out)
	}
	want := "upstream.timeout_ms = 5000\n" +
		"upstream.headers.Authorization = <redacted>\n" +
		"upstream.headers.X-Team = core\n" +
		"upstream.headers.x-api-key = <redacted>\n" +
		"retry.max_attempts = 3\n" +
		"retry.backoff_ms = 200\n" +
		"queue.size = 1000\n"
	if !strings.Contains(out, want) {
		t.Fatalf("got:\n%s", out)
	}
}

func TestRetryValues(t *testing.T) {
	cfg := config.Default()
	cfg.Retry = config.RetryConfig{MaxAttempts: 7, BackoffMS: 0}
	var sb strings.Builder
	if err := Config(&sb, cfg); err != nil {
		t.Fatal(err)
	}
	want := "upstream.timeout_ms = 5000\nretry.max_attempts = 7\nretry.backoff_ms = 0\nqueue.size = 1000\n"
	if !strings.Contains(sb.String(), want) {
		t.Fatalf("got:\n%s", sb.String())
	}
}
