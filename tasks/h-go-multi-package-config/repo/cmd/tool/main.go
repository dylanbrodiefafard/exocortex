// Command tool forwards webhook deliveries read from stdin (one JSON object
// per line: {"id": "...", "payload": {...}}) to the configured upstream.
//
// Usage:
//
//	tool [--config path] [--print-config | --check]
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"example.com/hookrelay/internal/app"
	"example.com/hookrelay/internal/config"
	"example.com/hookrelay/internal/logging"
	"example.com/hookrelay/internal/render"
)

func main() {
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr, app.HTTPSender{}))
}

// run is main without process globals, so tests can drive it. It returns the
// process exit code: 0 on success, 1 on a runtime failure, 2 on bad usage or
// an invalid configuration.
func run(args []string, getenv config.Getenv, stdin io.Reader, stdout, stderr io.Writer, sender app.Sender) int {
	fs := flag.NewFlagSet("tool", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "path to a JSON config file")
	printConfig := fs.Bool("print-config", false, "print the effective configuration and exit")
	check := fs.Bool("check", false, "validate the configuration and exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "unexpected arguments: %v\n", fs.Args())
		return 2
	}

	cfg, err := config.Load(*configPath, getenv)
	if err != nil {
		var verr *config.ValidationError
		if errors.As(err, &verr) {
			for _, p := range verr.Problems {
				fmt.Fprintf(stderr, "config error: %s\n", p)
			}
		} else {
			fmt.Fprintf(stderr, "config error: %v\n", err)
		}
		return 2
	}

	switch {
	case *printConfig:
		if err := render.Config(stdout, cfg); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	case *check:
		fmt.Fprintln(stdout, "config ok")
		return 0
	}

	level, _ := logging.ParseLevel(cfg.Log.Level)
	a := app.New(cfg, sender, app.WithLogger(logging.New(stderr, level, cfg.Log.Format)))
	scanner := bufio.NewScanner(stdin)
	for scanner.Scan() {
		if len(scanner.Bytes()) == 0 {
			continue
		}
		var d app.Delivery
		if err := json.Unmarshal(scanner.Bytes(), &d); err != nil {
			fmt.Fprintf(stderr, "bad input line: %v\n", err)
			return 1
		}
		if err := a.Enqueue(d); err != nil {
			fmt.Fprintf(stderr, "enqueue %s: %v\n", d.ID, err)
			return 1
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	results, err := a.Drain(context.Background())
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	failed := 0
	for _, r := range results {
		if r.Status < 200 || r.Status >= 400 {
			failed++
		}
	}
	fmt.Fprintf(stdout, "delivered %d/%d\n", len(results)-failed, len(results))
	if failed > 0 {
		return 1
	}
	return 0
}
