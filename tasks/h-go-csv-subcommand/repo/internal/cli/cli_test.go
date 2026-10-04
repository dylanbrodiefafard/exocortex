package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"example.com/glean/internal/commands"
)

// result is the outcome of one glean invocation.
type result struct {
	code   int
	stdout string
	stderr string
}

func run(t *testing.T, stdin string, args ...string) result {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Main(args, strings.NewReader(stdin), &out, &errOut)
	return result{code, out.String(), errOut.String()}
}

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestNoArgsPrintsOverviewToStderr(t *testing.T) {
	r := run(t, "")
	if r.code != ExitUsage || r.stdout != "" || !strings.Contains(r.stderr, "usage: glean <command>") {
		t.Fatalf("got %+v", r)
	}
}

func TestHelpListsCommandsSorted(t *testing.T) {
	r := run(t, "", "help")
	if r.code != 0 {
		t.Fatalf("code %d", r.code)
	}
	for _, line := range []string{
		"  convert    Rewrite the table with a different delimiter\n",
		"  count      Print the number of rows\n",
		"  filter     Keep rows where a column matches a regular expression\n",
		"  head       Print the first rows\n",
		"  headers    Print the column names with their indexes\n",
		"  join       Join two tables on key columns\n",
		"  rename     Rename columns\n",
		"  select     Keep only some columns, in the given order\n",
		"  sort       Sort rows by one or more columns\n",
		"  stats      Summarize each column: counts, and min/max/mean of numbers\n",
		"  uniq       Drop rows that repeat earlier rows\n",
	} {
		if !strings.Contains(r.stdout, line) {
			t.Errorf("help output lacks %q", line)
		}
	}
	_, list, _ := strings.Cut(r.stdout, "commands:\n")
	list, _, _ = strings.Cut(list, "\n\n")
	var names []string
	for _, line := range strings.Split(list, "\n") {
		names = append(names, strings.Fields(line)[0])
	}
	if len(names) != len(commands.All()) || !sort.StringsAreSorted(names) {
		t.Errorf("help should list every command once, sorted: %v", names)
	}
}

func TestHelpForCommand(t *testing.T) {
	r := run(t, "", "help", "head")
	want := "usage: glean head [-l LIMIT] [-d DELIM] [-n] [FILE]\n\nPrint the first rows.\n"
	if r.code != 0 || r.stdout != want {
		t.Fatalf("got %+v", r)
	}
	if r2 := run(t, "", "head", "-h"); r2.code != 0 || r2.stdout != want {
		t.Fatalf("head -h: got %+v", r2)
	}
	if r3 := run(t, "", "help", "nope"); r3.code != ExitUsage || r3.stderr != "glean help: unknown command \"nope\"\n" {
		t.Fatalf("got %+v", r3)
	}
}

func TestUnknownCommand(t *testing.T) {
	r := run(t, "", "frobnicate")
	if r.code != ExitUsage || !strings.HasPrefix(r.stderr, "glean: unknown command \"frobnicate\"\n") {
		t.Fatalf("got %+v", r)
	}
}

func TestVersion(t *testing.T) {
	if r := run(t, "", "version"); r.stdout != "glean "+Version+"\n" {
		t.Fatalf("got %+v", r)
	}
}

func TestUsageErrorFormat(t *testing.T) {
	r := run(t, "a\n1\n", "head", "-l", "-1")
	want := "glean head: -l must be >= 0, got -1\nusage: glean head [-l LIMIT] [-d DELIM] [-n] [FILE]\n"
	if r.code != ExitUsage || r.stderr != want {
		t.Fatalf("got %+v", r)
	}
	r = run(t, "a\n1\n", "head", "-x")
	if r.code != ExitUsage || !strings.HasPrefix(r.stderr, "glean head: flag provided but not defined: -x\nusage: ") {
		t.Fatalf("got %+v", r)
	}
}

func TestBadColumnIsUsageError(t *testing.T) {
	r := run(t, "a,b\n1,2\n", "select", "-s", "c")
	want := "glean select: unknown column \"c\"\nusage: glean select -s COLUMNS [-d DELIM] [-n] [FILE]\n"
	if r.code != ExitUsage || r.stderr != want {
		t.Fatalf("got %+v", r)
	}
}

func TestInputErrorsAreFailures(t *testing.T) {
	r := run(t, "", "count", "/nonexistent/x.csv")
	if r.code != ExitFailure || r.stderr != "glean count: open /nonexistent/x.csv: no such file or directory\n" {
		t.Fatalf("got %+v", r)
	}
	r = run(t, "a,b\n1\n", "count")
	if r.code != ExitFailure || r.stderr != "glean count: stdin: line 2: wrong number of fields\n" {
		t.Fatalf("got %+v", r)
	}
	r = run(t, "", "count")
	if r.code != ExitFailure || r.stderr != "glean count: stdin: input is empty\n" {
		t.Fatalf("got %+v", r)
	}
}

func TestReadsFiles(t *testing.T) {
	path := writeFile(t, "x.csv", "a\n1\n2\n")
	if r := run(t, "", "count", path); r.code != 0 || r.stdout != "2\n" {
		t.Fatalf("got %+v", r)
	}
	if r := run(t, "a\n1\n", "count", "-"); r.stdout != "1\n" {
		t.Fatalf("got %+v", r)
	}
	r := run(t, "", "count", path, path)
	if r.code != ExitUsage || !strings.HasPrefix(r.stderr, "glean count: too many arguments: "+path+"\n") {
		t.Fatalf("got %+v", r)
	}
}
