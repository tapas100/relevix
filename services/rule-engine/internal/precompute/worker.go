// Package precompute — idempotent per-tenant worker.
//
// A Worker executes one full precompute cycle for one tenant:
//
//	TryLock → Fetch signals → Evaluate rules → Score → Rank → WriteResult → Unlock
//
// Idempotency guarantee:
//   The Redis SETNX lock ensures that if two workers race to process the same
//   tenant at the same tick, exactly one wins and the other skips.  The losing
//   worker logs a skip and returns nil — it is not an error.
//
//   If the winner crashes before writing results, the lock expires after
//   LockTTL and the next tick will reprocess cleanly.  Because the write is
//   a Redis pipeline (SET + SET, not a transaction), a partial write is
//   possible in theory but benign — the next tick overwrites both keys
//   atomically through the pipeline.
package precompute

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
	"github.com/tapas100/relevix/services/rule-engine/internal/engine"
	"github.com/tapas100/relevix/services/rule-engine/internal/scorer"
)

// Worker executes one precompute cycle for one tenant.
type Worker struct {
	id           string // unique worker identifier (hostname + goroutine index)
	store        *Store
	fetcher      SignalFetcher
	rules        RuleSource
	impact       ImpactSource
	infraEngine  *engine.InfraEngine
	scorer       *scorer.Scorer
	tickInterval time.Duration
	log          zerolog.Logger
}

// WorkerConfig bundles all Worker dependencies.
type WorkerConfig struct {
	WorkerID     string
	Store        *Store
	Fetcher      SignalFetcher
	Rules        RuleSource
	Impact       ImpactSource
	InfraEngine  *engine.InfraEngine
	Scorer       *scorer.Scorer
	TickInterval time.Duration
	Log          zerolog.Logger
}

// NewWorker creates a Worker from a WorkerConfig.
func NewWorker(cfg WorkerConfig) *Worker {
	return &Worker{
		id:           cfg.WorkerID,
		store:        cfg.Store,
		fetcher:      cfg.Fetcher,
		rules:        cfg.Rules,
		impact:       cfg.Impact,
		infraEngine:  cfg.InfraEngine,
		scorer:       cfg.Scorer,
		tickInterval: cfg.TickInterval,
		log:          cfg.Log.With().Str("worker_id", cfg.WorkerID).Logger(),
	}
}

// RunForTenant executes the full precompute pipeline for one tenantID.
//
// Returns:
//   - nil          — success or deliberate skip (lock held by another worker)
//   - non-nil err  — unexpected failure that the scheduler should log
func (w *Worker) RunForTenant(ctx context.Context, tenantID string) error {
	start := time.Now()
	log := w.log.With().Str("tenant_id", tenantID).Logger()

	// ── Step 1: Acquire per-tenant lock ──────────────────────────────────────
	acquired, err := w.store.TryLock(ctx, tenantID, w.id)
	if err != nil {
		return fmt.Errorf("trylock: %w", err)
	}
	if !acquired {
		log.Debug().Msg("lock held by another worker — skipping tick")
		return nil // idempotent skip
	}
	defer func() {
		if uerr := w.store.Unlock(ctx, tenantID, w.id); uerr != nil {
			log.Warn().Err(uerr).Msg("unlock failed")
		}
	}()

	// ── Step 2: Fetch latest signals ──────────────────────────────────────────
	signals, err := w.fetcher.Fetch(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("fetch signals: %w", err)
	}
	if len(signals) == 0 {
		log.Debug().Msg("no signals — writing empty result")
	}

	// ── Step 3: Load rules for tenant ─────────────────────────────────────────
	rules, err := w.rules.RulesForTenant(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("load rules: %w", err)
	}

	// ── Step 4: Evaluate each signal through the rule engine ──────────────────
	var insights []scorer.Insight
	for _, sig := range signals {
		resp := w.infraEngine.Evaluate(sig, "precompute")
		for _, match := range resp.Matches {
			if match.Suppressed {
				continue
			}
			imp, ierr := w.impact.ImpactFor(ctx, tenantID, sig)
			if ierr != nil {
				log.Warn().Err(ierr).Msg("impact fetch failed — using zero impact")
			}
			insights = append(insights, scorer.FromRuleMatch(match, priorityOf(rules, match.RuleID), scorer.ImpactInput{
				AffectedServiceCount: imp.AffectedServiceCount,
				RequestsPerSecond:    imp.RequestsPerSecond,
				IsUserFacing:         imp.IsUserFacing,
				ExplicitScore:        imp.ExplicitScore,
			}))
		}
	}

	// ── Step 5: Score and rank ────────────────────────────────────────────────
	ranked := w.scorer.Rank(insights)

	// ── Step 6: Write to Redis ────────────────────────────────────────────────
	meta := CacheMetadata{
		TenantID:     tenantID,
		WorkerID:     w.id,
		ComputedAt:   time.Now().UTC(),
		DurationMS:   time.Since(start).Milliseconds(),
		SignalCount:  len(signals),
		RuleCount:    len(rules),
		InsightCount: len(ranked),
		TickInterval: w.tickInterval.String(),
	}
	if werr := w.store.WriteResult(ctx, meta, ranked); werr != nil {
		return fmt.Errorf("write result: %w", werr)
	}

	log.Info().
		Int("signals", len(signals)).
		Int("rules", len(rules)).
		Int("insights", len(ranked)).
		Int64("ms", meta.DurationMS).
		Msg("precompute cycle complete")

	return nil
}

// priorityOf returns the priority of a rule by ID, or 999 if not found.
func priorityOf(rules []domain.InfraRule, ruleID string) int {
	for _, r := range rules {
		if r.ID == ruleID {
			return r.Priority
		}
	}
	return 999
}
