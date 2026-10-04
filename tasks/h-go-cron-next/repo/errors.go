package cron

// ParseError describes an invalid cron expression.
type ParseError struct {
	Expr  string // the whole expression
	Field string // "minute", "hour", "day-of-month", "month" or "day-of-week"; "" if not specific to a field
	Msg   string
}

func (e *ParseError) Error() string {
	if e.Field == "" {
		return "cron: " + e.Msg + " in " + quote(e.Expr)
	}
	return "cron: " + e.Field + ": " + e.Msg + " in " + quote(e.Expr)
}

func quote(s string) string { return "\"" + s + "\"" }
