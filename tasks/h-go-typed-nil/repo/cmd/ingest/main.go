// Command ingest validates reading files (one per gateway) and prints a summary.
//
//	ingest [-workers N] [-not-before UNIX] [-not-after UNIX] FILE...
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"example.com/telemetry/ingest"
	"example.com/telemetry/reading"
	"example.com/telemetry/validate"
)

func main() {
	workers := flag.Int("workers", 0, "validation goroutines (default 4)")
	notBefore := flag.Int64("not-before", 0, "reject readings before this unix time")
	notAfter := flag.Int64("not-after", 0, "reject readings after this unix time")
	flag.Parse()

	var batches []ingest.Batch
	for _, path := range flag.Args() {
		f, err := os.Open(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		rs, err := reading.Parse(f)
		f.Close()
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", path, err)
			os.Exit(1)
		}
		gw := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		batches = append(batches, ingest.Batch{Gateway: gw, Readings: rs})
	}

	rep := ingest.Run(batches, ingest.Options{
		Workers: *workers,
		Window:  validate.Window{NotBefore: *notBefore, NotAfter: *notAfter},
	})

	fmt.Printf("accepted %d, rejected %d\n", rep.Accepted, len(rep.Rejected))
	for _, rj := range rep.Rejected {
		fmt.Printf("  %s %s\n", rj.Gateway, rj.Reason)
	}
	keys := make([]ingest.Key, 0, len(rep.Stats))
	for k := range rep.Stats {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Sensor != keys[j].Sensor {
			return keys[i].Sensor < keys[j].Sensor
		}
		return keys[i].Kind < keys[j].Kind
	})
	for _, k := range keys {
		s := rep.Stats[k]
		fmt.Printf("%-16s %-8s n=%d min=%g max=%g mean=%.2f\n", k.Sensor, k.Kind, s.Count, s.Min, s.Max, s.Mean())
	}
}
