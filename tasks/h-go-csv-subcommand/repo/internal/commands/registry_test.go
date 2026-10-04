package commands

import (
	"strings"
	"testing"
)

func TestRegistryIsConsistent(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range All() {
		if seen[c.Name] {
			t.Errorf("duplicate command %q", c.Name)
		}
		seen[c.Name] = true
		if Lookup(c.Name) != c {
			t.Errorf("Lookup(%q) does not return the registered command", c.Name)
		}
		if c.Summary == "" || strings.HasSuffix(c.Summary, ".") {
			t.Errorf("%s: summary %q must be non-empty and not end with a period", c.Name, c.Summary)
		}
		if !strings.HasPrefix(c.Usage, "glean "+c.Name) {
			t.Errorf("%s: usage %q must start with %q", c.Name, c.Usage, "glean "+c.Name)
		}
		if c.Run == nil {
			t.Errorf("%s: no Run", c.Name)
		}
	}
	if Lookup("nope") != nil {
		t.Error("Lookup of unknown command should be nil")
	}
}

func TestAllSorted(t *testing.T) {
	all := All()
	for i := 1; i < len(all); i++ {
		if all[i-1].Name > all[i].Name {
			t.Fatalf("All() not sorted: %s before %s", all[i-1].Name, all[i].Name)
		}
	}
}
