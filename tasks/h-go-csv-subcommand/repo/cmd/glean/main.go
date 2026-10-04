// Command glean inspects and reshapes CSV files.
package main

import (
	"os"

	"example.com/glean/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
