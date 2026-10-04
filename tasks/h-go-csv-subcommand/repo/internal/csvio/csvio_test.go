package csvio

import (
	"bytes"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestResolveColumns(t *testing.T) {
	header := []string{"id", "name", "2020", "city"}
	cases := []struct {
		spec string
		want []int
	}{
		{"", []int{0, 1, 2, 3}},
		{"name", []int{1}},
		{"city,id", []int{3, 0}},
		{"2", []int{1}},
		{"2-3", []int{1, 2}},
		{"3-", []int{2, 3}},
		{"-2", []int{0, 1}},
		{"id,id", []int{0, 0}},
		{" name , 4 ", []int{1, 3}},
	}
	for _, c := range cases {
		got, err := ResolveColumns(header, c.spec)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("ResolveColumns(%q) = %v, %v; want %v", c.spec, got, err, c.want)
		}
	}
}

func TestResolveColumnsErrors(t *testing.T) {
	header := []string{"a", "b", "c"}
	cases := map[string]string{
		"d":    `unknown column "d"`,
		"4":    "column index 4 out of range (input has 3 columns)",
		"0":    `invalid column index "0"`,
		"3-1":  `invalid column range "3-1"`,
		"a,,b": `empty item in column list "a,,b"`,
		"2-9":  "column index 9 out of range (input has 3 columns)",
	}
	for spec, want := range cases {
		_, err := ResolveColumns(header, spec)
		if err == nil || err.Error() != want {
			t.Errorf("ResolveColumns(%q) error = %v, want %q", spec, err, want)
		}
	}
}

func TestReadHeaderAndRows(t *testing.T) {
	tbl, err := Read(strings.NewReader("a;b\n1;\"x;y\"\n"), "in", Options{Comma: ';'})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tbl.Header, []string{"a", "b"}) || !reflect.DeepEqual(tbl.Rows, [][]string{{"1", "x;y"}}) {
		t.Fatalf("got %+v", tbl)
	}
	if got := tbl.Column(1); !reflect.DeepEqual(got, []string{"x;y"}) {
		t.Fatalf("Column = %v", got)
	}
}

func TestReadNoHeader(t *testing.T) {
	tbl, err := Read(strings.NewReader("x,y,z\n"), "in", Options{NoHeader: true})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tbl.Header, []string{"1", "2", "3"}) || len(tbl.Rows) != 1 {
		t.Fatalf("got %+v", tbl)
	}
}

func TestReadErrors(t *testing.T) {
	_, err := Read(strings.NewReader("a,b\n1,2\n3\n"), "data.csv", Options{})
	if err == nil || err.Error() != "data.csv: line 3: wrong number of fields" {
		t.Fatalf("got %v", err)
	}
	_, err = Read(strings.NewReader(""), "data.csv", Options{})
	if !errors.Is(err, ErrEmpty) {
		t.Fatalf("got %v", err)
	}
}

func TestWriter(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf, '\t')
	w.Write("a", "b c")
	w.Write("x\ty", "")
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); got != "a\tb c\n\"x\ty\"\t\n" {
		t.Fatalf("got %q", got)
	}
}

func TestParseDelimiter(t *testing.T) {
	for in, want := range map[string]rune{",": ',', "tab": '\t', `\t`: '\t', "pipe": '|', ";": ';', "é": 'é'} {
		got, err := ParseDelimiter(in)
		if err != nil || got != want {
			t.Errorf("ParseDelimiter(%q) = %q, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "ab", `"`, "\n"} {
		if _, err := ParseDelimiter(in); err == nil {
			t.Errorf("ParseDelimiter(%q) should fail", in)
		}
	}
}

func TestNumbers(t *testing.T) {
	for in, want := range map[string]float64{"1": 1, " 2.5 ": 2.5, "-3e2": -300} {
		if got, ok := ParseNumber(in); !ok || got != want {
			t.Errorf("ParseNumber(%q) = %v, %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "x", "NaN", "inf", "1,000"} {
		if _, ok := ParseNumber(in); ok {
			t.Errorf("ParseNumber(%q) should fail", in)
		}
	}
	a, b := 0.1, 0.2
	if got := FormatNumber(a + b); got != "0.30000000000000004" {
		t.Errorf("FormatNumber = %s", got)
	}
	if got := FormatNumber(3); got != "3" {
		t.Errorf("FormatNumber = %s", got)
	}
}
