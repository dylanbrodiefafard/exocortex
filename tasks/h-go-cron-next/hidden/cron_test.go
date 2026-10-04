package cron

import (
	"errors"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04", s)
	if err != nil {
		panic(err)
	}
	return t
}

func checkNext(t *testing.T, expr, from, want string) {
	t.Helper()
	s, err := Parse(expr)
	if err != nil {
		t.Fatalf("Parse(%q): %v", expr, err)
	}
	got := s.Next(at(from))
	if !got.Equal(at(want)) {
		t.Errorf("Parse(%q).Next(%s) = %s, want %s", expr, from, got.Format("2006-01-02 15:04 Mon"), want)
	}
}

// seq returns the next n firing times starting after from.
func seq(t *testing.T, expr, from string, n int) []string {
	t.Helper()
	s, err := Parse(expr)
	if err != nil {
		t.Fatalf("Parse(%q): %v", expr, err)
	}
	cur := at(from)
	var out []string
	for i := 0; i < n; i++ {
		cur = s.Next(cur)
		if cur.IsZero() {
			out = append(out, "zero")
			break
		}
		out = append(out, cur.Format("2006-01-02 15:04"))
	}
	return out
}

func checkSeq(t *testing.T, expr, from string, want ...string) {
	t.Helper()
	got := seq(t, expr, from, len(want))
	if len(got) != len(want) {
		t.Errorf("%q from %s: got %v, want %v", expr, from, got, want)
		return
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%q from %s: got %v, want %v", expr, from, got, want)
			return
		}
	}
}

func parseErr(t *testing.T, expr string) *ParseError {
	t.Helper()
	s, err := Parse(expr)
	if err == nil {
		t.Errorf("Parse(%q) = %v, want error", expr, s)
		return nil
	}
	var pe *ParseError
	if !errors.As(err, &pe) {
		t.Errorf("Parse(%q) error %v (%T) is not a *ParseError", expr, err, err)
		return nil
	}
	if pe.Expr != expr {
		t.Errorf("Parse(%q): ParseError.Expr = %q", expr, pe.Expr)
	}
	return pe
}

// --- visible tests ---------------------------------------------------------

func TestDaily(t *testing.T) {
	checkNext(t, "30 9 * * *", "2024-03-10 08:00", "2024-03-10 09:30")
	checkNext(t, "30 9 * * *", "2024-03-10 10:00", "2024-03-11 09:30")
}

func TestListsAndRanges(t *testing.T) {
	checkNext(t, "0,15,30,45 * * * *", "2024-03-10 08:16", "2024-03-10 08:30")
	checkNext(t, "0 9-17 * * *", "2024-03-10 17:30", "2024-03-11 09:00")
}

func TestSteps(t *testing.T) {
	checkNext(t, "*/15 * * * *", "2024-03-10 08:16", "2024-03-10 08:30")
	checkNext(t, "0 */6 * * *", "2024-03-10 13:00", "2024-03-10 18:00")
}

func TestMonthRollover(t *testing.T) {
	checkNext(t, "0 0 1 * *", "2024-12-15 12:00", "2025-01-01 00:00")
}

func TestDayOfWeek(t *testing.T) {
	// 2024-03-10 is a Sunday.
	checkNext(t, "0 12 * * 3", "2024-03-10 00:00", "2024-03-13 12:00")
}

func TestWrongFieldCount(t *testing.T) {
	_, err := Parse("* * * *")
	var pe *ParseError
	if !errors.As(err, &pe) {
		t.Fatalf("Parse with 4 fields: got %v, want *ParseError", err)
	}
}

// --- syntax ----------------------------------------------------------------

func TestWhitespace(t *testing.T) {
	checkNext(t, "  30\t9   *  * \t* ", "2024-03-10 08:00", "2024-03-10 09:30")
	s := MustParse(" 30 9 * * * ")
	if s.String() != " 30 9 * * * " {
		t.Errorf("String() = %q, want the original text", s.String())
	}
}

func TestStepForms(t *testing.T) {
	checkSeq(t, "5/20 * * * *", "2024-03-10 08:00", "2024-03-10 08:05", "2024-03-10 08:25", "2024-03-10 08:45", "2024-03-10 09:05")
	checkSeq(t, "10-30/10 * * * *", "2024-03-10 08:00", "2024-03-10 08:10", "2024-03-10 08:20", "2024-03-10 08:30", "2024-03-10 09:10")
	checkSeq(t, "0 1-23/22 * * *", "2024-03-10 00:00", "2024-03-10 01:00", "2024-03-10 23:00", "2024-03-11 01:00")
	checkSeq(t, "0 0 */10 * *", "2024-03-01 00:00", "2024-03-11 00:00", "2024-03-21 00:00", "2024-03-31 00:00", "2024-04-01 00:00")
	checkSeq(t, "*/100 * * * *", "2024-03-10 08:00", "2024-03-10 09:00", "2024-03-10 10:00")
	checkSeq(t, "0 0 1 */5 *", "2024-02-01 00:00", "2024-06-01 00:00", "2024-11-01 00:00", "2025-01-01 00:00")
	checkSeq(t, "0,30-40/5,59 * * * *", "2024-03-10 08:01", "2024-03-10 08:30", "2024-03-10 08:35", "2024-03-10 08:40", "2024-03-10 08:59", "2024-03-10 09:00")
}

func TestNames(t *testing.T) {
	// 2024-03-10 is a Sunday.
	checkSeq(t, "0 9 * * MON-FRI", "2024-03-08 10:00", "2024-03-11 09:00", "2024-03-12 09:00")
	checkSeq(t, "0 9 * * mon,Wed,fRi", "2024-03-10 00:00", "2024-03-11 09:00", "2024-03-13 09:00", "2024-03-15 09:00", "2024-03-18 09:00")
	checkSeq(t, "0 0 1 jan-mar/2 *", "2024-01-15 00:00", "2024-03-01 00:00", "2025-01-01 00:00")
	checkSeq(t, "0 0 1 JUN,Dec *", "2024-01-15 00:00", "2024-06-01 00:00", "2024-12-01 00:00")
	checkSeq(t, "0 0 * * SAT/7", "2024-03-10 00:00", "2024-03-16 00:00", "2024-03-23 00:00")
	checkSeq(t, "0 0 1 FEB/6 *", "2024-03-10 00:00", "2024-08-01 00:00", "2025-02-01 00:00")
	checkSeq(t, "0 0 * * sun", "2024-03-10 00:00", "2024-03-17 00:00")
}

func TestSundaySeven(t *testing.T) {
	checkSeq(t, "0 0 * * 7", "2024-03-10 00:00", "2024-03-17 00:00", "2024-03-24 00:00")
	checkSeq(t, "0 0 * * 5-7", "2024-03-10 00:00", "2024-03-15 00:00", "2024-03-16 00:00", "2024-03-17 00:00", "2024-03-22 00:00")
	checkSeq(t, "0 0 * * 0,7", "2024-03-10 00:00", "2024-03-17 00:00", "2024-03-24 00:00")
	checkSeq(t, "0 0 * * FRI-7", "2024-03-10 00:00", "2024-03-15 00:00", "2024-03-16 00:00", "2024-03-17 00:00")
	checkSeq(t, "0 0 * * */3", "2024-03-10 00:00", "2024-03-13 00:00", "2024-03-16 00:00", "2024-03-17 00:00")
}

func TestMacros(t *testing.T) {
	checkNext(t, "@yearly", "2024-03-10 08:00", "2025-01-01 00:00")
	checkNext(t, "@annually", "2024-03-10 08:00", "2025-01-01 00:00")
	checkNext(t, "@monthly", "2024-03-10 08:00", "2024-04-01 00:00")
	checkNext(t, "@weekly", "2024-03-10 08:00", "2024-03-17 00:00")
	checkNext(t, "@daily", "2024-03-10 08:00", "2024-03-11 00:00")
	checkNext(t, "@midnight", "2024-03-10 08:00", "2024-03-11 00:00")
	checkNext(t, "@hourly", "2024-03-10 08:00", "2024-03-10 09:00")
	checkNext(t, "  @hourly\t", "2024-03-10 08:59", "2024-03-10 09:00")
	if s := MustParse("@daily"); s.String() != "@daily" {
		t.Errorf("String() = %q, want %q", s.String(), "@daily")
	}
	for _, expr := range []string{"@DAILY", "@every 5m", "@", "@reboot", "@daily *"} {
		if pe := parseErr(t, expr); pe != nil && pe.Field != "" {
			t.Errorf("Parse(%q): Field = %q, want \"\"", expr, pe.Field)
		}
	}
}

// --- day-of-month / day-of-week ---------------------------------------------

func TestDomDowUnion(t *testing.T) {
	// March 2024: Fridays are 1, 8, 15, 22, 29.
	checkSeq(t, "0 0 13 * FRI", "2024-03-01 00:00", "2024-03-08 00:00", "2024-03-13 00:00", "2024-03-15 00:00", "2024-03-22 00:00")
	checkSeq(t, "0 0 1,15 * MON", "2024-03-10 00:00", "2024-03-11 00:00", "2024-03-15 00:00", "2024-03-18 00:00")
	// */1 is restricted (not exactly "*"): union with day-of-month.
	checkSeq(t, "0 0 */1 * MON", "2024-03-10 00:00", "2024-03-11 00:00", "2024-03-12 00:00")
	checkSeq(t, "0 0 31 * */7", "2024-03-25 00:00", "2024-03-31 00:00", "2024-04-07 00:00")
}

func TestDomOnlyOrDowOnly(t *testing.T) {
	checkSeq(t, "0 0 13 * *", "2024-03-01 00:00", "2024-03-13 00:00", "2024-04-13 00:00")
	checkSeq(t, "0 0 * * FRI", "2024-03-01 00:00", "2024-03-08 00:00", "2024-03-15 00:00")
}

func TestMatches(t *testing.T) {
	s := MustParse("30 9 13 * FRI")
	cases := []struct {
		when string
		want bool
	}{
		{"2024-03-13 09:30", true},  // Wednesday the 13th
		{"2024-03-15 09:30", true},  // Friday
		{"2024-03-14 09:30", false}, // Thursday the 14th
		{"2024-03-15 09:31", false},
	}
	for _, c := range cases {
		if got := s.Matches(at(c.when)); got != c.want {
			t.Errorf("Matches(%s) = %v, want %v", c.when, got, c.want)
		}
	}
	if !s.Matches(at("2024-03-15 09:30").Add(59 * time.Second)) {
		t.Error("Matches should ignore seconds")
	}
	if !MustParse("0 0 * * 7").Matches(at("2024-03-10 00:00")) {
		t.Error("7 should match Sunday in Matches")
	}
	if !MustParse("@hourly").Matches(at("2024-03-10 05:00")) {
		t.Error("@hourly should match 05:00")
	}
}

// --- Next semantics --------------------------------------------------------

func TestStrictlyAfter(t *testing.T) {
	checkNext(t, "30 9 * * *", "2024-03-10 09:30", "2024-03-11 09:30")
	checkNext(t, "* * * * *", "2024-03-10 10:00", "2024-03-10 10:01")
}

func TestSecondsTruncated(t *testing.T) {
	s := MustParse("* * * * *")
	from := time.Date(2024, 3, 10, 10, 0, 30, 500, time.UTC)
	got := s.Next(from)
	want := time.Date(2024, 3, 10, 10, 1, 0, 0, time.UTC)
	if !got.Equal(want) || got.Nanosecond() != 0 || got.Second() != 0 {
		t.Errorf("Next(%v) = %v, want %v", from, got, want)
	}
	s = MustParse("30 9 * * *")
	from = time.Date(2024, 3, 10, 9, 29, 59, 999999999, time.UTC)
	if got := s.Next(from); !got.Equal(time.Date(2024, 3, 10, 9, 30, 0, 0, time.UTC)) {
		t.Errorf("Next(%v) = %v", from, got)
	}
	from = time.Date(2024, 3, 10, 9, 30, 0, 1, time.UTC)
	if got := s.Next(from); !got.Equal(time.Date(2024, 3, 11, 9, 30, 0, 0, time.UTC)) {
		t.Errorf("Next(%v) = %v", from, got)
	}
}

func TestLocation(t *testing.T) {
	plus530 := time.FixedZone("IST", 5*3600+30*60)
	s := MustParse("0 9 * * *")
	from := time.Date(2024, 3, 10, 8, 0, 0, 0, plus530)
	got := s.Next(from)
	want := time.Date(2024, 3, 10, 9, 0, 0, 0, plus530)
	if !got.Equal(want) {
		t.Errorf("Next in +05:30 = %v, want %v", got, want)
	}
	if got.Location() != plus530 {
		t.Errorf("result location = %v, want %v", got.Location(), plus530)
	}
	minus7 := time.FixedZone("X", -7*3600)
	// 2024-03-10 23:30 at -07:00 is already Monday in UTC; Sunday matching uses the local wall clock.
	s = MustParse("45 23 * * SUN")
	got = s.Next(time.Date(2024, 3, 10, 23, 30, 0, 0, minus7))
	if want := time.Date(2024, 3, 10, 23, 45, 0, 0, minus7); !got.Equal(want) {
		t.Errorf("Next in -07:00 = %v, want %v", got, want)
	}
	if !s.Matches(time.Date(2024, 3, 10, 23, 45, 0, 0, minus7)) {
		t.Error("Matches should use the wall clock of t's location")
	}
}

func TestLeapDay(t *testing.T) {
	checkNext(t, "0 0 29 2 *", "2024-03-01 00:00", "2028-02-29 00:00")
	checkNext(t, "0 12 31 * *", "2024-04-01 00:00", "2024-05-31 12:00")
}

func TestFiveYearLimit(t *testing.T) {
	start := time.Now()
	if got := MustParse("0 0 30 2 *").Next(at("2024-01-01 00:00")); !got.IsZero() {
		t.Errorf("Feb 30: got %v, want zero time", got)
	}
	if got := MustParse("0 0 31 4,6,9,11 *").Next(at("2024-01-01 00:00")); !got.IsZero() {
		t.Errorf("31st of 30-day months: got %v, want zero time", got)
	}
	// 2100 is not a leap year: the next Feb 29 after 2097-03-01 is in 2104, more than 5 years away.
	if got := MustParse("0 0 29 2 *").Next(at("2097-03-01 00:00")); !got.IsZero() {
		t.Errorf("Feb 29 from 2097: got %v, want zero time", got)
	}
	// Exactly 5 years later is still in range.
	checkNext(t, "0 0 1 1 *", "2023-01-01 00:00", "2024-01-01 00:00")
	checkNext(t, "30 6 10 3 *", "2024-03-10 06:30", "2025-03-10 06:30")
	checkNext(t, "0 0 29 2 *", "2023-02-28 23:59", "2024-02-29 00:00")
	checkNext(t, "15 4 1 3 *", "2023-03-01 04:16", "2024-03-01 04:15")
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("unsatisfiable schedules took %v", elapsed)
	}
}

func TestFiveYearBoundary(t *testing.T) {
	s := MustParse("0 0 29 2 *")
	// The limit is after.AddDate(5, 0, 0): 2104-03-01 00:00, so 2104-02-29 is in range.
	if got := s.Next(at("2099-03-01 00:00")); !got.Equal(at("2104-02-29 00:00")) {
		t.Errorf("from 2099-03-01: got %v, want 2104-02-29 00:00", got)
	}
	// Here the limit is 2104-02-28 23:59, one minute too early.
	if got := s.Next(at("2099-02-28 23:59")); !got.IsZero() {
		t.Errorf("from 2099-02-28 23:59: got %v, want zero time", got)
	}
	// Restricted day-of-week alone still finds a result well within the limit.
	if got := MustParse("30 6 * 3 SUN").Next(at("2024-03-10 06:30")); !got.Equal(at("2024-03-17 06:30")) {
		t.Errorf("got %v", got)
	}
}

// --- errors ----------------------------------------------------------------

func TestFieldErrors(t *testing.T) {
	cases := []struct{ expr, field string }{
		{"60 * * * *", "minute"},
		{"-1 * * * *", "minute"},
		{"* 24 * * *", "hour"},
		{"* * 0 * *", "day-of-month"},
		{"* * 32 * *", "day-of-month"},
		{"* * * 0 *", "month"},
		{"* * * 13 *", "month"},
		{"* * * * 8", "day-of-week"},
		{"30-10 * * * *", "minute"},
		{"* * * DEC-JAN *", "month"},
		{"* * * * FRI-MON", "day-of-week"},
		{"*/0 * * * *", "minute"},
		{"* */ * * *", "hour"},
		{"* * 1/x * *", "day-of-month"},
		{"* * * */-1 *", "month"},
		{"1,,2 * * * *", "minute"},
		{"1, * * * *", "minute"},
		{",1 * * * *", "minute"},
		{"* * * * MON,", "day-of-week"},
		{"* * * FOO *", "month"},
		{"* * * * MONDAY", "day-of-week"},
		{"* * * * JAN", "day-of-week"},
		{"* * * MON *", "month"},
		{"* * MON * *", "day-of-month"},
		{"JAN * * * *", "minute"},
		{"* SUN * * *", "hour"},
		{"a * * * *", "minute"},
		{"1-2-3 * * * *", "minute"},
		{"1- * * * *", "minute"},
		{"*-5 * * * *", "minute"},
		{"5/2/1 * * * *", "minute"},
		{"** * * * *", "minute"},
		{"+5 * * * *", "minute"},
		{"0 0 * * 1-8", "day-of-week"},
		{"0 0 1-31/0 * *", "day-of-month"},
		{"0 0 * * 7-5", "day-of-week"},
	}
	for _, c := range cases {
		pe := parseErr(t, c.expr)
		if pe != nil && pe.Field != c.field {
			t.Errorf("Parse(%q): Field = %q, want %q", c.expr, pe.Field, c.field)
		}
	}
}

func TestFieldCountErrors(t *testing.T) {
	for _, expr := range []string{"", "   ", "* * * *", "* * * * * *", "0 0 1 1 * 2024"} {
		pe := parseErr(t, expr)
		if pe != nil && pe.Field != "" {
			t.Errorf("Parse(%q): Field = %q, want \"\"", expr, pe.Field)
		}
	}
}

func TestValidEdges(t *testing.T) {
	for _, expr := range []string{
		"0-59 0-23 1-31 1-12 0-7",
		"59 23 31 12 7",
		"0 0 1 1 0",
		"5-5 * * * *",
		"0 0 * * 7/1",
		"0 0 * * 1-7/2",
		"0 0 1-31/31 * *",
		"0 0 * jan-DEC *",
	} {
		if _, err := Parse(expr); err != nil {
			t.Errorf("Parse(%q): %v", expr, err)
		}
	}
	checkSeq(t, "0 0 * * 1-7/2", "2024-03-10 00:00", "2024-03-11 00:00", "2024-03-13 00:00", "2024-03-15 00:00", "2024-03-17 00:00")
}
