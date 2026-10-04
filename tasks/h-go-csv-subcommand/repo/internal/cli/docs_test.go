package cli

import (
	"os"
	"strings"
	"testing"

	"example.com/glean/internal/commands"
)

// Every command must be documented in docs/commands.md under a
// "## glean <name>" heading that is followed by its usage line.
func TestEveryCommandIsDocumented(t *testing.T) {
	data, err := os.ReadFile("../../docs/commands.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(data)
	for _, c := range commands.All() {
		heading := "\n## glean " + c.Name + "\n"
		i := strings.Index(doc, heading)
		if i < 0 {
			t.Errorf("docs/commands.md has no %q section", strings.TrimSpace(heading))
			continue
		}
		section := doc[i+len(heading):]
		if j := strings.Index(section, "\n## "); j >= 0 {
			section = section[:j]
		}
		if !strings.Contains(section, "    "+c.Usage+"\n") {
			t.Errorf("docs/commands.md: section for %s does not show the usage line %q", c.Name, c.Usage)
		}
	}
}
