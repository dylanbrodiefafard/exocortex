package bizday

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

const layout = "2006-01-02"

func readRows(t *testing.T, path string) [][]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var rows [][]string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if line := sc.Text(); line != "" && !strings.HasPrefix(line, "#") {
			rows = append(rows, strings.Split(line, "\t"))
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return rows
}

func mustDate(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse(layout, s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestAdd(t *testing.T) {
	for _, row := range readRows(t, "testdata/add.txt") {
		start, nStr, want := row[0], row[1], row[2]
		n, _ := strconv.Atoi(nStr)
		t.Run(start+"/"+nStr, func(t *testing.T) {
			got := Add(mustDate(t, start), n).Format(layout)
			if got != want {
				t.Errorf("Add(%s, %d) = %s, want %s", start, n, got, want)
			}
		})
	}
}

func TestBetween(t *testing.T) {
	for _, row := range readRows(t, "testdata/between.txt") {
		a, b := row[0], row[1]
		want, _ := strconv.Atoi(row[2])
		t.Run(a+".."+b, func(t *testing.T) {
			if got := Between(mustDate(t, a), mustDate(t, b)); got != want {
				t.Errorf("Between(%s, %s) = %d, want %d", a, b, got, want)
			}
			if got := Between(mustDate(t, b), mustDate(t, a)); got != -want {
				t.Errorf("Between(%s, %s) = %d, want %d", b, a, got, -want)
			}
		})
	}
}

func TestAddIgnoresTimeOfDay(t *testing.T) {
	d := time.Date(2024, 3, 28, 23, 30, 0, 0, time.UTC)
	if got := Add(d, 1).Format(layout); got != "2024-04-02" {
		t.Errorf("Add(%v, 1) = %s, want 2024-04-02", d, got)
	}
}

func TestNextPrev(t *testing.T) {
	if got := Next(mustDate(t, "2024-12-24")).Format(layout); got != "2024-12-27" {
		t.Errorf("Next(2024-12-24) = %s", got)
	}
	if got := Prev(mustDate(t, "2024-04-02")).Format(layout); got != "2024-03-28" {
		t.Errorf("Prev(2024-04-02) = %s", got)
	}
}
