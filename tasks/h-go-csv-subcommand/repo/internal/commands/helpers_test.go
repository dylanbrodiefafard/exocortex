package commands

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"
)

// exec runs a command directly and returns its stdout and error.
func exec(t *testing.T, stdin, name string, args ...string) (string, error) {
	t.Helper()
	cmd := Lookup(name)
	if cmd == nil {
		t.Fatalf("no command %q", name)
	}
	var out, errOut bytes.Buffer
	err := cmd.Run(&Env{Stdin: strings.NewReader(stdin), Stdout: &out, Stderr: &errOut}, args)
	return out.String(), err
}

// mustExec is exec that fails the test on error.
func mustExec(t *testing.T, stdin, name string, args ...string) string {
	t.Helper()
	out, err := exec(t, stdin, name, args...)
	if err != nil {
		t.Fatalf("%s %v: %v", name, args, err)
	}
	return out
}

func cities(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("../../testdata/cities.csv")
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertUsageError(t *testing.T, err error, msg string) {
	t.Helper()
	var ue *UsageError
	if !errors.As(err, &ue) {
		t.Fatalf("want *UsageError %q, got %v", msg, err)
	}
	if ue.Msg != msg {
		t.Fatalf("usage error = %q, want %q", ue.Msg, msg)
	}
}
