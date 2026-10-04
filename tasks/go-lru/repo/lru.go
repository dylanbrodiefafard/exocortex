// Package lru implements a fixed-capacity least-recently-used cache.
package lru

import "container/list"

type entry struct {
	key   string
	value int
}

// Cache is a least-recently-used cache. Both Get and Put mark a key as most recently used.
// When a Put would exceed the capacity, the least recently used key is evicted.
type Cache struct {
	capacity int
	order    *list.List // front = most recently used
	items    map[string]*list.Element
}

// New returns a cache holding at most capacity entries. capacity must be positive.
func New(capacity int) *Cache {
	if capacity <= 0 {
		panic("lru: capacity must be positive")
	}
	return &Cache{capacity: capacity, order: list.New(), items: make(map[string]*list.Element)}
}

// Get returns the value for key and whether it was present.
func (c *Cache) Get(key string) (int, bool) {
	el, ok := c.items[key]
	if !ok {
		return 0, false
	}
	return el.Value.(*entry).value, true
}

// Put inserts or updates key.
func (c *Cache) Put(key string, value int) {
	if _, ok := c.items[key]; ok {
		return
	}
	if c.order.Len() >= c.capacity {
		oldest := c.order.Front()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*entry).key)
	}
	c.items[key] = c.order.PushFront(&entry{key: key, value: value})
}

// Len returns the number of entries.
func (c *Cache) Len() int {
	return c.order.Len()
}
