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
