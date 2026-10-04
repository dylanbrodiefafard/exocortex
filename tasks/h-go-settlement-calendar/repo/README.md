# workdays

Settlement-calendar library used by the payments service to work out value dates
(`T+2` and friends) and SLA deadlines in business days.

- `holiday`: the public holidays of a year and the day each one is observed.
- `bizday`: business-day predicates and arithmetic on top of `holiday`.

CI runs `go test -v -count=1 ./...` and archives the full verbose log, one line per
case, for the audit trail. The tables under `*/testdata/` are generated from the
published calendar and are the source of truth; don't edit them.

## Holidays

The calendar follows the rule-based England & Wales bank holidays (one-off holidays
such as jubilees are not modelled). Supported years are 1900 to 2199 inclusive;
`ForYear` returns an error for any other year.

| Holiday | Date |
|---|---|
| New Year's Day | 1 January |
| Good Friday | two days before Easter Sunday |
| Easter Monday | the day after Easter Sunday |
| Early May Bank Holiday | first Monday in May |
| Spring Bank Holiday | last Monday in May |
| Summer Bank Holiday | last Monday in August |
| Christmas Day | 25 December |
| Boxing Day | 26 December |

Easter Sunday is the Gregorian (Western) Easter for the year.

`ForYear` lists the holidays in order of their `Date`.

### Observed days

A holiday that falls on a weekday is observed on that day. A holiday that falls on a
Saturday or Sunday is observed on the first following weekday that is not already a
holiday or another holiday's observed day; holidays are given their substitute days in
date order. No two holidays are ever observed on the same day. For example:

- Christmas on Saturday, Boxing Day on Sunday: observed Monday 27 and Tuesday 28.
- Christmas on Sunday: Boxing Day is Monday 26 (observed that day), so Christmas is observed Tuesday 27.
- New Year's Day on Sunday: observed Monday 2 January.

## Business days

A business day is a Monday to Friday that is not an observed holiday. Times of day are
ignored: every function works on the calendar date of its argument (in its location).

- `Next(t)` / `Prev(t)`: the first business day strictly after / before `t`.
- `Add(t, n)`: move `n` business days forwards (`n > 0`) or backwards (`n < 0`); the
  starting day is never counted, so `Add(friday, 1)` is the following Monday. `Add(t, 0)`
  is `t` if it is a business day and `Next(t)` otherwise.
- `Between(a, b)`: the number of business days in `(a, b]` when `a` is before `b`, and
  minus the number in `(b, a]` when `b` is before `a`.
