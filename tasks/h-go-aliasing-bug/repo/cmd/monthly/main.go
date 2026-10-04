// Command monthly prints a month-by-month spending report for one year.
//
//	monthly -year 2024 -exclude transfer export1.csv [export2.csv ...]
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"example.com/ledger/parser"
	"example.com/ledger/report"
)

func main() {
	year := flag.Int("year", 0, "calendar year to report")
	exclude := flag.String("exclude", "transfer", "comma-separated categories to leave out")
	flag.Parse()
	if *year == 0 || flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: monthly -year YYYY [-exclude cats] export.csv...")
		os.Exit(2)
	}
	var entries []parser.Entry
	for _, path := range flag.Args() {
		f, err := os.Open(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		parsed, err := parser.Parse(f)
		f.Close()
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", path, err)
			os.Exit(1)
		}
		entries = append(entries, parsed...)
	}
	var excluded []string
	if *exclude != "" {
		excluded = strings.Split(*exclude, ",")
	}
	if err := report.Render(os.Stdout, report.Monthly(entries, *year, excluded)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
