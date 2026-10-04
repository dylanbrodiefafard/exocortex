package commands

import (
	"os"
	"path/filepath"
	"testing"
)

func tempCSV(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestJoinInner(t *testing.T) {
	left := tempCSV(t, "l.csv", "id,name\n1,ann\n2,bob\n3,cy\n")
	right := tempCSV(t, "r.csv", "uid,score\n1,10\n3,7\n1,12\n")
	got := mustExec(t, "", "join", "-k", "id", "-K", "uid", left, right)
	want := "id,name,score\n1,ann,10\n1,ann,12\n3,cy,7\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestJoinLeft(t *testing.T) {
	left := tempCSV(t, "l.csv", "id,name\n1,ann\n2,bob\n")
	right := tempCSV(t, "r.csv", "id,score,rank\n1,10,a\n")
	got := mustExec(t, "", "join", "-k", "id", "-left", left, right)
	if got != "id,name,score,rank\n1,ann,10,a\n2,bob,,\n" {
		t.Fatalf("got %q", got)
	}
}

func TestJoinStdinAndFixtures(t *testing.T) {
	got := mustExec(t, "country,n\nAndorra,1\nItaly,2\n", "join", "-k", "country", "-", "../../testdata/countries.csv")
	if got != "country,n,capital,currency\nAndorra,1,Andorra la Vella,EUR\n" {
		t.Fatalf("got %q", got)
	}
}

func TestJoinErrors(t *testing.T) {
	f := tempCSV(t, "x.csv", "a,b\n1,2\n")
	_, err := exec(t, "", "join", "-k", "a", f)
	assertUsageError(t, err, "expected two files, got 1")
	_, err = exec(t, "", "join", "-k", "a,b", "-K", "a", f, f)
	assertUsageError(t, err, "-k selects 2 columns but -K selects 1")
	_, err = exec(t, "", "join", "-k", "zz", f, f)
	assertUsageError(t, err, `unknown column "zz"`)
	_, err = exec(t, "", "join", f, f)
	assertUsageError(t, err, "-k is required")
}
