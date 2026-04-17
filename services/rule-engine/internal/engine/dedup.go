// Package engine — deduplication store.
//
// The dedup store tracks how many times each (rule, key) combination has fired
// within the configured window. It is kept in-process (not Redis) for
// sub-millisecond performance. A separate distributed dedup layer (Redis) is
// used for multi-instance deployments.
//
// Eviction: entries older than their window are lazily evicted on access, plus
// a background sweep every sweepInterval to bound memory use.
package engine

import (
	"bytes"
	"sync"
	"text/template"
	"time"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

const sweepInterval = time.Minute

// dedupEntry tracks firings for a single (ruleID, key) pair.
type dedupEntry struct {
	count     int
	windowEnd time.Time
}

// DedupStore tracks firing counts for deduplication.
// It is goroutine-safe.
type DedupStore struct {
	mu      sync.Mutex
	entries map[string]*dedupEntry // key: ruleID + "|" + resolvedKey
	now     func() time.Time       // injectable for testing
}

// NewDedupStore creates a store with a background sweeper.
func NewDedupStore() *DedupStore {
	s := &DedupStore{
		entries: make(map[string]*dedupEntry),
		now:     time.Now,
	}
	go s.sweep()
	return s
}

// newDedupStoreWithClock creates a store with a custom clock (for testing).
func newDedupStoreWithClock(now func() time.Time) *DedupStore {
	return &DedupStore{
		entries: make(map[string]*dedupEntry),
		now:     now,
	}
}

// Check returns (dedupKey, suppressed).
// suppressed == true when the dedup window is active and max_fire is reached.
// It increments the counter on every non-suppressed call.
func (s *DedupStore) Check(rule domain.InfraRule, ctx map[string]any) (string, bool) {
	if rule.Dedup == nil || rule.Dedup.Key == "" {
		return "", false
	}

	key, err := resolveTemplate(rule.Dedup.Key, ctx)
	if err != nil {
		key = rule.ID // fallback
	}

	storeKey := rule.ID + "|" + key
	now := s.now()

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, exists := s.entries[storeKey]
	if !exists || now.After(entry.windowEnd) {
		// New window — reset counter.
		s.entries[storeKey] = &dedupEntry{
			count:     1,
			windowEnd: now.Add(rule.Dedup.Window),
		}
		return key, false
	}

	// Within existing window.
	if rule.Dedup.MaxFire > 0 && entry.count >= rule.Dedup.MaxFire {
		return key, true // suppressed
	}
	entry.count++
	return key, false
}

// sweep periodically removes expired entries to bound memory.
func (s *DedupStore) sweep() {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for range ticker.C {
		now := s.now()
		s.mu.Lock()
		for k, e := range s.entries {
			if now.After(e.windowEnd) {
				delete(s.entries, k)
			}
		}
		s.mu.Unlock()
	}
}

// resolveTemplate executes a Go text/template against the flat context map.
// Template keys use dot notation matching the DSL: {{ .meta.tenant_id }}
func resolveTemplate(tmpl string, ctx map[string]any) (string, error) {
	t, err := template.New("dedup").
		Option("missingkey=zero").
		Parse(tmpl)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, flatToTemplateData(ctx)); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// flatToTemplateData converts the flat context map into a nested structure
// that text/template can access with {{ .namespace.field }} notation.
func flatToTemplateData(ctx map[string]any) map[string]any {
	return ctx // already nested — EvalContext.ToFlatMap() produces nested maps
}
