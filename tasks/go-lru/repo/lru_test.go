package lru

import "testing"

func mustGet(t *testing.T, c *Cache, key string, want int) {
	t.Helper()
	got, ok := c.Get(key)
	if !ok || got != want {
		t.Fatalf("Get(%q) = %d, %v; want %d, true", key, got, ok, want)
	}
}

func mustMiss(t *testing.T, c *Cache, key string) {
	t.Helper()
	if got, ok := c.Get(key); ok {
		t.Fatalf("Get(%q) = %d, true; want miss", key, got)
	}
}

func TestEvictsLeastRecentlyPut(t *testing.T) {
	c := New(2)
	c.Put("a", 1)
	c.Put("b", 2)
	c.Put("c", 3)
	mustMiss(t, c, "a")
	mustGet(t, c, "b", 2)
	mustGet(t, c, "c", 3)
}

func TestGetRefreshesRecency(t *testing.T) {
	c := New(2)
	c.Put("a", 1)
	c.Put("b", 2)
	mustGet(t, c, "a", 1)
	c.Put("c", 3)
	mustMiss(t, c, "b")
	mustGet(t, c, "a", 1)
	mustGet(t, c, "c", 3)
}

func TestPutUpdatesValueAndRecency(t *testing.T) {
	c := New(2)
	c.Put("a", 1)
	c.Put("b", 2)
	c.Put("a", 10)
	c.Put("c", 3)
	mustGet(t, c, "a", 10)
	mustMiss(t, c, "b")
	if c.Len() != 2 {
		t.Fatalf("Len() = %d; want 2", c.Len())
	}
}

func TestCapacityOne(t *testing.T) {
	c := New(1)
	c.Put("a", 1)
	c.Put("b", 2)
	mustMiss(t, c, "a")
	mustGet(t, c, "b", 2)
}
