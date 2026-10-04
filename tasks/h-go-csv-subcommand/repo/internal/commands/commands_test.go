package commands

import (
	"strings"
	"testing"
)

func TestHeaders(t *testing.T) {
	got := mustExec(t, "id,full name\n1,x\n", "headers")
	want := "1  id\n2  full name\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestCount(t *testing.T) {
	if got := mustExec(t, cities(t), "count"); got != "11\n" {
		t.Fatalf("got %q", got)
	}
	if got := mustExec(t, "a\nb\n", "count", "-n"); got != "2\n" {
		t.Fatalf("got %q", got)
	}
}

func TestSelect(t *testing.T) {
	got := mustExec(t, "a,b,c\n1,2,3\n4,5,6\n", "select", "-s", "c,1")
	if got != "c,a\n3,1\n6,4\n" {
		t.Fatalf("got %q", got)
	}
	got = mustExec(t, "1;2;3\n", "select", "-n", "-d", ";", "-s", "2-")
	if got != "2;3\n" {
		t.Fatalf("got %q", got)
	}
	_, err := exec(t, "a\n1\n", "select")
	assertUsageError(t, err, "-s is required")
}

func TestHead(t *testing.T) {
	got := mustExec(t, cities(t), "head", "-l", "2")
	want := "city,country,population,area_km2,coastal\nLisbon,Portugal,545923,100.05,yes\nPorto,Portugal,231800,41.42,yes\n"
	if got != want {
		t.Fatalf("got %q", got)
	}
	_, err := exec(t, "a\n", "head", "-s", "a")
	assertUsageError(t, err, "flag provided but not defined: -s")
}

func TestHeadLimit(t *testing.T) {
	got := mustExec(t, "a\n1\n2\n3\n", "head", "-l", "2")
	if got != "a\n1\n2\n" {
		t.Fatalf("got %q", got)
	}
	if got := mustExec(t, "a\n1\n", "head", "-l", "0"); got != "a\n" {
		t.Fatalf("got %q", got)
	}
	_, err := exec(t, "a\n1\n", "head", "-l", "-3")
	assertUsageError(t, err, "-l must be >= 0, got -3")
}

func TestSort(t *testing.T) {
	in := "name,n\nb,10\na,9\nc,x\nd,9\n"
	if got := mustExec(t, in, "sort", "-s", "n", "-N"); got != "name,n\na,9\nd,9\nb,10\nc,x\n" {
		t.Fatalf("numeric: got %q", got)
	}
	if got := mustExec(t, in, "sort", "-s", "n"); got != "name,n\nb,10\na,9\nd,9\nc,x\n" {
		t.Fatalf("string: got %q", got)
	}
	if got := mustExec(t, in, "sort", "-s", "name", "-r"); got != "name,n\nd,9\nc,x\nb,10\na,9\n" {
		t.Fatalf("reverse: got %q", got)
	}
}

func TestFilter(t *testing.T) {
	got := mustExec(t, cities(t), "filter", "-s", "country", "-e", "^Port")
	if got != "city,country,population,area_km2,coastal\nLisbon,Portugal,545923,100.05,yes\nPorto,Portugal,231800,41.42,yes\n" {
		t.Fatalf("got %q", got)
	}
	got = mustExec(t, "a,b\nx,1\ny,2\n", "filter", "-e", "x|1", "-v")
	if got != "a,b\ny,2\n" {
		t.Fatalf("invert: got %q", got)
	}
	_, err := exec(t, "a\n", "filter", "-e", "(")
	if err == nil || !strings.HasPrefix(err.Error(), "-e: error parsing regexp") {
		t.Fatalf("got %v", err)
	}
}

func TestStats(t *testing.T) {
	got := mustExec(t, cities(t), "stats", "-s", "population,area_km2,coastal")
	want := "field,rows,empty,numeric,min,max,mean\n" +
		"population,11,1,10,22615,3332035,785658.8\n" +
		"area_km2,11,0,11,12,604.3,141.23\n" +
		"coastal,11,0,0,,,\n"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestStatsHeaderlessUsesIndexes(t *testing.T) {
	got := mustExec(t, "1,x\n3,y\n", "stats", "-n")
	want := "field,rows,empty,numeric,min,max,mean\n1,2,0,2,1,3,2\n2,2,0,0,,,\n"
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestBadDelimiter(t *testing.T) {
	_, err := exec(t, "a\n", "count", "-d", "ab")
	assertUsageError(t, err, `-d: delimiter must be a single character, got "ab"`)
}

func TestColumnErrorsAreUsageErrors(t *testing.T) {
	_, err := exec(t, "a,b\n1,2\n", "stats", "-s", "5")
	assertUsageError(t, err, "column index 5 out of range (input has 2 columns)")
	_, err = exec(t, "a,b\n1,2\n", "sort", "-s", "nope")
	assertUsageError(t, err, `unknown column "nope"`)
}

func TestStatsMeanRounding(t *testing.T) {
	got := mustExec(t, "v\n1\n2\n2\n", "stats")
	if got != "field,rows,empty,numeric,min,max,mean\nv,3,0,3,1,2,1.666667\n" {
		t.Fatalf("got %q", got)
	}
}

func TestUniq(t *testing.T) {
	in := "k,v\na,1\nA,2\na,1\nb,1\n"
	if got := mustExec(t, in, "uniq"); got != "k,v\na,1\nA,2\nb,1\n" {
		t.Fatalf("got %q", got)
	}
	if got := mustExec(t, in, "uniq", "-s", "k", "-i"); got != "k,v\na,1\nb,1\n" {
		t.Fatalf("fold: got %q", got)
	}
	if got := mustExec(t, "x,y\nab,c\na,bc\n", "uniq"); got != "x,y\nab,c\na,bc\n" {
		t.Fatalf("boundaries: got %q", got)
	}
}

func TestRename(t *testing.T) {
	got := mustExec(t, "a,b,c\n1,2,3\n", "rename", "-r", "a=alpha,3=gamma")
	if got != "alpha,b,gamma\n1,2,3\n" {
		t.Fatalf("got %q", got)
	}
	_, err := exec(t, "a,b\n", "rename", "-r", "a")
	assertUsageError(t, err, `-r: expected OLD=NEW, got "a"`)
	_, err = exec(t, "a,b\n", "rename", "-r", "1-2=x")
	assertUsageError(t, err, `-r: "1-2" selects 2 columns, want 1`)
	_, err = exec(t, "a,b\n", "rename", "-r", "z=x")
	assertUsageError(t, err, `unknown column "z"`)
}

func TestConvert(t *testing.T) {
	got := mustExec(t, "a;b\n1;x,y\n", "convert", "-d", ";", "-o", "comma")
	if got != "a,b\n1,\"x,y\"\n" {
		t.Fatalf("got %q", got)
	}
	_, err := exec(t, "a\n", "convert")
	assertUsageError(t, err, "-o is required")
}
