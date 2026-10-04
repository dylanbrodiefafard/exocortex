package holiday

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

func TestEaster(t *testing.T) {
	for _, row := range readRows(t, "testdata/easter.txt") {
		year, _ := strconv.Atoi(row[0])
		want := row[1]
		t.Run(row[0], func(t *testing.T) {
			got := Easter(year)
			if got.Format(layout) != want {
				t.Errorf("Easter(%d) = %s, want %s", year, got.Format(layout), want)
			}
			if got.Weekday() != time.Sunday {
				t.Errorf("Easter(%d) = %s is a %s", year, got.Format(layout), got.Weekday())
			}
		})
	}
}

func TestForYear(t *testing.T) {
	cache := map[int][]Holiday{}
	for _, row := range readRows(t, "testdata/holidays.txt") {
		year, _ := strconv.Atoi(row[0])
		name, date, observed := row[1], row[2], row[3]
		t.Run(row[0]+"/"+name, func(t *testing.T) {
			hs, ok := cache[year]
			if !ok {
				var err error
				hs, err = ForYear(year)
				if err != nil {
					t.Fatalf("ForYear(%d): %v", year, err)
				}
				cache[year] = hs
			}
			for _, h := range hs {
				if h.Name != name {
					continue
				}
				if got := h.Date.Format(layout); got != date {
					t.Errorf("%d %s: Date = %s, want %s", year, name, got, date)
				}
				if got := h.Observed.Format(layout); got != observed {
					t.Errorf("%d %s: Observed = %s, want %s", year, name, got, observed)
				}
				return
			}
			t.Errorf("%d: no holiday named %q", year, name)
		})
	}
}

func TestForYearCountAndOrder(t *testing.T) {
	for year := MinYear; year <= MaxYear; year++ {
		hs, err := ForYear(year)
		if err != nil {
			t.Fatal(err)
		}
		if len(hs) != 8 {
			t.Fatalf("ForYear(%d) returned %d holidays, want 8", year, len(hs))
		}
		seen := map[time.Time]string{}
		for i, h := range hs {
			if i > 0 && h.Date.Before(hs[i-1].Date) {
				t.Errorf("ForYear(%d): %s listed after %s", year, h.Name, hs[i-1].Name)
			}
			if wd := h.Observed.Weekday(); wd == time.Saturday || wd == time.Sunday {
				t.Errorf("ForYear(%d): %s observed on a %s", year, h.Name, wd)
			}
			if other, dup := seen[h.Observed]; dup {
				t.Errorf("ForYear(%d): %s and %s both observed on %s", year, other, h.Name, h.Observed.Format(layout))
			}
			seen[h.Observed] = h.Name
		}
	}
}

func TestYearRange(t *testing.T) {
	for _, y := range []int{MinYear - 1, MaxYear + 1, 0, -5} {
		if _, err := ForYear(y); err == nil {
			t.Errorf("ForYear(%d) succeeded, want error", y)
		}
	}
}

func TestIsObserved(t *testing.T) {
	cases := []struct {
		day  string
		want bool
	}{
		{"2024-01-01", true}, {"2024-03-29", true}, {"2024-04-01", true}, {"2024-05-06", true},
		{"2024-05-27", true}, {"2024-08-26", true}, {"2024-12-25", true}, {"2024-12-26", true},
		{"2024-12-27", false}, {"2023-01-02", true}, {"2023-01-01", false}, {"2024-07-04", false},
	}
	for _, c := range cases {
		t.Run(c.day, func(t *testing.T) {
			d, _ := time.Parse(layout, c.day)
			if got := IsObserved(d); got != c.want {
				t.Errorf("IsObserved(%s) = %v, want %v", c.day, got, c.want)
			}
		})
	}
}
