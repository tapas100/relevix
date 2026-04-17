// Package precompute — Redis schema and cache store.
//
// Key layout (all keys are UTF-8 strings):
//
//	relevix:pc:{tenantID}:insights          STRING  JSON []scorer.RankedInsight
//	relevix:pc:{tenantID}:meta              STRING  JSON CacheMetadata
//	relevix:pc:lock:{tenantID}              STRING  workerID  (SETNX, TTL = lockTTL)
//	relevix:pc:tenants                      SET     known tenantIDs
//
// TTL policy:
//   - insights + meta TTL = 2 × TickInterval (so stale results survive one missed tick)
//   - lock TTL = LockTTL (< TickInterval, so a crashed worker never blocks the next cycle)
//
// All reads are O(1) single GET — query latency is bounded by Redis RTT (~0.5 ms
// on localhost, ~2–5 ms cross-AZ).
package precompute

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/tapas100/relevix/services/rule-engine/internal/scorer"
)

// ─── Key helpers ──────────────────────────────────────────────────────────────

func keyInsights(tenantID string) string {
	return fmt.Sprintf("relevix:pc:%s:insights", tenantID)
}
func keyMeta(tenantID string) string {
	return fmt.Sprintf("relevix:pc:%s:meta", tenantID)
}
func keyLock(tenantID string) string {
	return fmt.Sprintf("relevix:pc:lock:%s", tenantID)
}

const keyTenants = "relevix:pc:tenants"

// ─── Stored types ─────────────────────────────────────────────────────────────

// CacheMetadata is written alongside the insights to support observability.
type CacheMetadata struct {
	TenantID     string    `json:"tenant_id"`
	WorkerID     string    `json:"worker_id"`
	ComputedAt   time.Time `json:"computed_at"`
	DurationMS   int64     `json:"duration_ms"`
	SignalCount  int       `json:"signal_count"`
	RuleCount    int       `json:"rule_count"`
	InsightCount int       `json:"insight_count"`
	TickInterval string    `json:"tick_interval"`
}

// CacheResult is the full value returned by a single tenant query.
type CacheResult struct {
	Insights []scorer.RankedInsight `json:"insights"`
	Meta     CacheMetadata          `json:"meta"`
	// FromCache is always true for precomputed results.
	FromCache bool `json:"from_cache"`
}

// ─── Store ────────────────────────────────────────────────────────────────────

// Store wraps a Redis client and provides typed cache read/write operations.
type Store struct {
	rdb        redis.Cmdable
	resultsTTL time.Duration // how long insights+meta survive
	lockTTL    time.Duration // how long a worker lock is held
}

// NewStore creates a Store.
//   resultsTTL is typically 2 × TickInterval.
//   lockTTL is typically 0.8 × TickInterval (shorter so a crash can't block the next cycle).
func NewStore(rdb redis.Cmdable, resultsTTL, lockTTL time.Duration) *Store {
	return &Store{rdb: rdb, resultsTTL: resultsTTL, lockTTL: lockTTL}
}

// TryLock attempts to acquire the per-tenant processing lock.
// Returns true if the lock was acquired (this worker should proceed).
// Returns false if another worker already holds the lock (skip this tenant).
//
// Uses SET NX PX which is atomic — no TOCTOU race is possible.
func (s *Store) TryLock(ctx context.Context, tenantID, workerID string) (bool, error) {
	ok, err := s.rdb.SetNX(ctx, keyLock(tenantID), workerID, s.lockTTL).Result()
	return ok, err
}

// Unlock releases the per-tenant lock.  Only releases if the calling worker
// still holds it (compare-and-delete via Lua script).
func (s *Store) Unlock(ctx context.Context, tenantID, workerID string) error {
	script := redis.NewScript(`
		if redis.call("GET", KEYS[1]) == ARGV[1] then
			return redis.call("DEL", KEYS[1])
		else
			return 0
		end
	`)
	return script.Run(ctx, s.rdb, []string{keyLock(tenantID)}, workerID).Err()
}

// WriteResult atomically writes insights + metadata for a tenant.
// Uses a pipeline so both keys are written in a single round-trip.
func (s *Store) WriteResult(ctx context.Context, meta CacheMetadata, insights []scorer.RankedInsight) error {
	insJSON, err := json.Marshal(insights)
	if err != nil {
		return fmt.Errorf("marshal insights: %w", err)
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("marshal meta: %w", err)
	}

	pipe := s.rdb.Pipeline()
	pipe.Set(ctx, keyInsights(meta.TenantID), insJSON, s.resultsTTL)
	pipe.Set(ctx, keyMeta(meta.TenantID), metaJSON, s.resultsTTL)
	_, err = pipe.Exec(ctx)
	return err
}

// ReadResult returns the cached insights + metadata for a tenant.
// Returns (nil, nil) when the key does not exist (cache miss — caller should
// fall back to live evaluation).
func (s *Store) ReadResult(ctx context.Context, tenantID string) (*CacheResult, error) {
	pipe := s.rdb.Pipeline()
	insCmd := pipe.Get(ctx, keyInsights(tenantID))
	metaCmd := pipe.Get(ctx, keyMeta(tenantID))
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("pipeline exec: %w", err)
	}

	insData, err := insCmd.Bytes()
	if err == redis.Nil {
		return nil, nil // cache miss
	}
	if err != nil {
		return nil, fmt.Errorf("read insights: %w", err)
	}

	metaData, err := metaCmd.Bytes()
	if err != nil {
		return nil, fmt.Errorf("read meta: %w", err)
	}

	var insights []scorer.RankedInsight
	if err := json.Unmarshal(insData, &insights); err != nil {
		return nil, fmt.Errorf("unmarshal insights: %w", err)
	}
	var meta CacheMetadata
	if err := json.Unmarshal(metaData, &meta); err != nil {
		return nil, fmt.Errorf("unmarshal meta: %w", err)
	}

	return &CacheResult{Insights: insights, Meta: meta, FromCache: true}, nil
}

// RegisterTenant adds a tenantID to the known-tenants set.
// Idempotent — SADD is a no-op if the member already exists.
func (s *Store) RegisterTenant(ctx context.Context, tenantID string) error {
	return s.rdb.SAdd(ctx, keyTenants, tenantID).Err()
}

// ListTenants returns all registered tenant IDs.
func (s *Store) ListTenants(ctx context.Context) ([]string, error) {
	return s.rdb.SMembers(ctx, keyTenants).Result()
}

// Invalidate removes cached results for a tenant (e.g. after rule updates).
func (s *Store) Invalidate(ctx context.Context, tenantID string) error {
	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, keyInsights(tenantID))
	pipe.Del(ctx, keyMeta(tenantID))
	_, err := pipe.Exec(ctx)
	return err
}
