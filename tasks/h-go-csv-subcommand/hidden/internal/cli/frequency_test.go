package cli

import (
	"strings"
	"testing"
)

const freqUsage = "usage: glean frequency [-s COLUMNS] [-l LIMIT] [-d DELIM] [-n] [FILE]\n"

const freqInput = "name,colour,size\n" +
	"pear,green,m\n" +
	"apple,red,s\n" +
	"plum,purple,\n" +
	"cherry,red,s\n" +
	"lime,green,s\n" +
	"grape,green,\n" +
	"fig,purple,m\n"

func TestFrequencySelectedColumns(t *testing.T) {
	r := run(t, freqInput, "frequency", "-s", "colour,size")
	want := "field,value,count\n" +
		"colour,green,3\n" +
		"colour,purple,2\n" +
		"colour,red,2\n" +
		"size,s,3\n" +
		"size,(empty),2\n" +
		"size,m,2\n"
	if r.code != 0 || r.stdout != want || r.stderr != "" {
		t.Fatalf("got %+v\nwant stdout:\n%s", r, want)
	}
}

func TestFrequencyDefaultsToAllColumnsInOrder(t *testing.T) {
	r := run(t, "b,a\nx,1\ny,1\nx,2\n", "frequency")
	want := "field,value,count\nb,x,2\nb,y,1\na,1,2\na,2,1\n"
	if r.code != 0 || r.stdout != want {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencySelectionOrderAndIndexes(t *testing.T) {
	r := run(t, freqInput, "frequency", "-s", "3,colour", "-l", "1")
	want := "field,value,count\nsize,s,3\ncolour,green,3\n"
	if r.code != 0 || r.stdout != want {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencyLimit(t *testing.T) {
	var b strings.Builder
	b.WriteString("v\n")
	for i := 0; i < 12; i++ {
		b.WriteString(string(rune('a'+i)) + "\n")
	}
	b.WriteString("k\nk\n")
	r := run(t, b.String(), "frequency")
	lines := strings.Split(strings.TrimSuffix(r.stdout, "\n"), "\n")
	if r.code != 0 || len(lines) != 11 {
		t.Fatalf("default limit should be 10 values: %+v", r)
	}
	if lines[1] != "v,k,3" || lines[2] != "v,a,1" || lines[10] != "v,i,1" {
		t.Fatalf("got %q", lines)
	}
	r = run(t, b.String(), "frequency", "-l", "0")
	if got := strings.Count(r.stdout, "\n"); r.code != 0 || got != 13 {
		t.Fatalf("-l 0 should write all 12 values: %+v", r)
	}
	r = run(t, b.String(), "frequency", "-l", "2")
	if r.stdout != "field,value,count\nv,k,3\nv,a,1\n" {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencyExactValues(t *testing.T) {
	r := run(t, "v\nA\na\n a\na\n", "frequency")
	want := "field,value,count\nv,a,2\nv,\" a\",1\nv,A,1\n"
	if r.code != 0 || r.stdout != want {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencyDelimiterAndNoHeader(t *testing.T) {
	r := run(t, "x;1\ny;1\nx;2\n", "frequency", "-n", "-d", ";")
	want := "field;value;count\n1;x;2\n1;y;1\n2;1;2\n2;2;1\n"
	if r.code != 0 || r.stdout != want {
		t.Fatalf("got %+v", r)
	}
	r = run(t, "a\tb\n1\tx y\n", "frequency", "-d", "tab", "-s", "b")
	if r.code != 0 || r.stdout != "field\tvalue\tcount\nb\tx y\t1\n" {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencyQuotesOutput(t *testing.T) {
	r := run(t, "v\n\"a,b\"\n", "frequency")
	if r.code != 0 || r.stdout != "field,value,count\nv,\"a,b\",1\n" {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencyReadsFile(t *testing.T) {
	path := writeFile(t, "f.csv", freqInput)
	r := run(t, "", "frequency", "-s", "colour", "-l", "1", path)
	if r.code != 0 || r.stdout != "field,value,count\ncolour,green,3\n" {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencyUsageErrors(t *testing.T) {
	cases := []struct {
		args []string
		msg  string
	}{
		{[]string{"frequency", "-l", "-1"}, "-l must be >= 0, got -1"},
		{[]string{"frequency", "-s", "weight"}, `unknown column "weight"`},
		{[]string{"frequency", "-s", "7"}, "column index 7 out of range (input has 3 columns)"},
		{[]string{"frequency", "-x"}, "flag provided but not defined: -x"},
		{[]string{"frequency", "-d", "ab"}, `-d: delimiter must be a single character, got "ab"`},
		{[]string{"frequency", "a.csv", "b.csv"}, "too many arguments: b.csv"},
	}
	for _, c := range cases {
		r := run(t, freqInput, c.args...)
		want := "glean frequency: " + c.msg + "\n" + freqUsage
		if r.code != ExitUsage || r.stderr != want || r.stdout != "" {
			t.Errorf("%v: got %+v, want stderr %q", c.args, r, want)
		}
	}
}

func TestFrequencyFailures(t *testing.T) {
	r := run(t, "", "frequency", "/nonexistent/f.csv")
	if r.code != ExitFailure || r.stderr != "glean frequency: open /nonexistent/f.csv: no such file or directory\n" {
		t.Fatalf("got %+v", r)
	}
	r = run(t, "a,b\n1\n", "frequency")
	if r.code != ExitFailure || r.stderr != "glean frequency: stdin: line 2: wrong number of fields\n" {
		t.Fatalf("got %+v", r)
	}
}

func TestFrequencyHelp(t *testing.T) {
	r := run(t, "", "help")
	if !strings.Contains(r.stdout, "\n  frequency  Count how often each value occurs in each column\n") {
		t.Fatalf("help does not list frequency:\n%s", r.stdout)
	}
	want := freqUsage + "\nCount how often each value occurs in each column.\n"
	if r := run(t, "", "help", "frequency"); r.code != 0 || r.stdout != want {
		t.Fatalf("help frequency: got %+v", r)
	}
	if r := run(t, "", "frequency", "-h"); r.code != 0 || r.stdout != want {
		t.Fatalf("frequency -h: got %+v", r)
	}
}
