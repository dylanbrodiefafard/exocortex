package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"example.com/hookrelay/internal/app"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func okSender() app.Sender {
	return app.SenderFunc(func(ctx context.Context, req app.Request) (int, error) { return 200, nil })
}

func runTool(t *testing.T, args []string, vars map[string]string, stdin string) (int, string, string) {
	t.Helper()
	var stdout, stderr strings.Builder
	code := run(args, env(vars), strings.NewReader(stdin), &stdout, &stderr, okSender())
	return code, stdout.String(), stderr.String()
}

func writeConfig(t *testing.T, doc string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "relay.json")
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPrintConfigFromFile(t *testing.T) {
	path := writeConfig(t, `{"upstream": {"url": "https://hooks.example.com/in"}, "queue": {"workers": 2}}`)
	code, out, errOut := runTool(t, []string{"--config", path, "--print-config"}, nil, "")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, want := range []string{"upstream.url = https://hooks.example.com/in\n", "queue.workers = 2\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestInvalidConfigExitsTwo(t *testing.T) {
	code, _, errOut := runTool(t, []string{"--check"}, map[string]string{"TOOL_QUEUE_WORKERS": "100"}, "")
	if code != 2 || !strings.Contains(errOut, "config error: queue.workers: must be between 1 and 64, got 100") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}

func TestCheck(t *testing.T) {
	code, out, _ := runTool(t, []string{"--check"}, nil, "")
	if code != 0 || out != "config ok\n" {
		t.Fatalf("exit %d, out %q", code, out)
	}
}

func TestRelayFromStdin(t *testing.T) {
	code, out, errOut := runTool(t, nil, nil, `{"id":"a","payload":{}}`+"\n\n"+`{"id":"b","payload":[1]}`+"\n")
	if code != 0 || out != "delivered 2/2\n" {
		t.Fatalf("exit %d, out %q, stderr %q", code, out, errOut)
	}
}

func TestBadUsage(t *testing.T) {
	if code, _, _ := runTool(t, []string{"--nope"}, nil, ""); code != 2 {
		t.Fatalf("exit %d", code)
	}
	if code, _, _ := runTool(t, []string{"extra"}, nil, ""); code != 2 {
		t.Fatalf("exit %d", code)
	}
}

func TestPrintConfigDefaults(t *testing.T) {
	code, out, errOut := runTool(t, []string{"--print-config"}, nil, "")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
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
	if out != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
}

func TestPrintConfigRetryFromFileAndEnv(t *testing.T) {
	path := writeConfig(t, `{"retry": {"max_attempts": 4, "backoff_ms": 25}, "upstream": {"headers": {"Authorization": "Bearer x"}}}`)
	code, out, errOut := runTool(t, []string{"--config", path, "--print-config"}, map[string]string{"TOOL_RETRY_MAX_ATTEMPTS": "6"}, "")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	want := "upstream.timeout_ms = 5000\n" +
		"upstream.headers.Authorization = <redacted>\n" +
		"retry.max_attempts = 6\n" +
		"retry.backoff_ms = 25\n" +
		"queue.size = 1000\n"
	if !strings.Contains(out, want) {
		t.Fatalf("got:\n%s", out)
	}
}

func TestInvalidRetryConfig(t *testing.T) {
	code, _, errOut := runTool(t, []string{"--print-config"}, map[string]string{"TOOL_RETRY_MAX_ATTEMPTS": "0", "TOOL_RETRY_BACKOFF_MS": "70000"}, "")
	if code != 2 {
		t.Fatalf("exit %d", code)
	}
	for _, want := range []string{
		"config error: retry.max_attempts: must be between 1 and 10, got 0\n",
		"config error: retry.backoff_ms: must be between 0 and 60000, got 70000\n",
	} {
		if !strings.Contains(errOut, want) {
			t.Errorf("missing %q in stderr:\n%s", want, errOut)
		}
	}
}

func TestBadRetryEnvInteger(t *testing.T) {
	code, _, errOut := runTool(t, []string{"--check"}, map[string]string{"TOOL_RETRY_BACKOFF_MS": "fast"}, "")
	if code != 2 || !strings.Contains(errOut, "TOOL_RETRY_BACKOFF_MS") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}
