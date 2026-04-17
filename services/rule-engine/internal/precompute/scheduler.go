// Package precompute — Scheduler.
//
// The Scheduler drives the precompute loop:
//
//	every tick:
//	  1. List all registered tenants from Redis
//	  2. For each tenant, dispatch a Worker goroutine (bounded by semaphore)
//	  3. Workers run concurrently; the semaphore caps parallelism
//
// Tick interval is configurable between MinTickInterval and MaxTickInterval.
// The scheduler jitters each tick by ±10% to prevent all instances in a
// multi-replica deployment from waking up at exactly the same moment.
//
// Scalability model:
//   - Each rule-engine replica runs its own Scheduler.
//   - Per-tenant Redis SETNX locks ensure exactly-once processing per tick
//     even when N replicas run simultaneously.
//   - Workers within a single scheduler share a semaphore to cap Redis
//     connection pressure.  Default concurrency = min(numCPU, 16).
package precompute

import (
	"context"
	"math/rand/v2"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

const (
	MinTickInterval = 10 * time.Second
	MaxTickInterval = 5 * time.Minute
	defaultJitter   = 0.10 // ±10% of tick interval
)

// SchedulerConfig holds all Scheduler options.
type SchedulerConfig struct {
	// TickInterval is the target precompute frequency (default 30s).
	// Clamped to [MinTickInterval, MaxTickInterval].
	TickInterval time.Duration

	// MaxConcurrency caps how many tenants are processed in parallel.
	// Default: min(runtime.NumCPU(), 16).
	MaxConcurrency int

	// WorkerIDPrefix is prepended to the hostname in the worker ID.
	// Default: "rule-engine".
	WorkerIDPrefix string

	// DisableJitter disables tick jitter (useful in tests for determinism).
	DisableJitter bool

	Log zerolog.Logger
}

// DefaultSchedulerConfig returns safe production defaults.
func DefaultSchedulerConfig(log zerolog.Logger) SchedulerConfig {
	conc := runtime.NumCPU()
	if conc > 16 {
		conc = 16
	}
	return SchedulerConfig{
		TickInterval:   30 * time.Second,
		MaxConcurrency: conc,
		WorkerIDPrefix: "rule-engine",
		Log:            log,
	}
}

// Scheduler orchestrates the periodic precompute loop.
type Scheduler struct {
	cfg        SchedulerConfig
	workerCfg  WorkerConfig // template — WorkerID is overridden per goroutine
	store      *Store
	stopCh     chan struct{}
	log        zerolog.Logger
	workerID   string
}

// NewScheduler creates a Scheduler.
// workerCfg is used as a template for all workers; the WorkerID field is
// replaced with a unique per-instance ID derived from the hostname.
func NewScheduler(cfg SchedulerConfig, workerCfg WorkerConfig, store *Store) *Scheduler {
	// Clamp tick interval.
	tick := cfg.TickInterval
	if tick < MinTickInterval {
		tick = MinTickInterval
	}
	if tick > MaxTickInterval {
		tick = MaxTickInterval
	}
	cfg.TickInterval = tick

	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = runtime.NumCPU()
	}

	hostname, _ := os.Hostname()
	workerID := cfg.WorkerIDPrefix + "/" + hostname

	return &Scheduler{
		cfg:       cfg,
		workerCfg: workerCfg,
		store:     store,
		stopCh:    make(chan struct{}),
		log:       cfg.Log.With().Str("component", "scheduler").Logger(),
		workerID:  workerID,
	}
}

// Start begins the tick loop in a background goroutine.
// Call Stop to shut it down cleanly.
func (s *Scheduler) Start(ctx context.Context) {
	go s.loop(ctx)
	s.log.Info().
		Dur("tick", s.cfg.TickInterval).
		Int("concurrency", s.cfg.MaxConcurrency).
		Str("worker_id", s.workerID).
		Msg("precompute scheduler started")
}

// Stop signals the scheduler to stop after the current tick completes.
// It blocks until the loop exits.
func (s *Scheduler) Stop() {
	close(s.stopCh)
}

// TriggerNow runs one precompute cycle immediately (bypasses the ticker).
// Useful for forcing a refresh after a rule update.
// Blocks until the cycle completes.
func (s *Scheduler) TriggerNow(ctx context.Context) {
	s.runCycle(ctx)
}

// loop is the main ticker goroutine.
func (s *Scheduler) loop(ctx context.Context) {
	// Fire once immediately on startup so the cache is warm before the first tick.
	s.runCycle(ctx)

	for {
		interval := s.jitteredInterval()
		select {
		case <-time.After(interval):
			s.runCycle(ctx)
		case <-s.stopCh:
			s.log.Info().Msg("precompute scheduler stopped")
			return
		case <-ctx.Done():
			s.log.Info().Msg("precompute scheduler context cancelled")
			return
		}
	}
}

// runCycle processes all tenants for one tick.
func (s *Scheduler) runCycle(ctx context.Context) {
	cycleStart := time.Now()

	tenants, err := s.store.ListTenants(ctx)
	if err != nil {
		s.log.Error().Err(err).Msg("failed to list tenants — skipping cycle")
		return
	}
	if len(tenants) == 0 {
		s.log.Debug().Msg("no tenants registered — nothing to precompute")
		return
	}

	// Semaphore: buffered channel caps concurrency.
	sem := make(chan struct{}, s.cfg.MaxConcurrency)
	var wg sync.WaitGroup

	for _, tenantID := range tenants {
		wg.Add(1)
		sem <- struct{}{} // acquire slot

		go func(tid string) {
			defer wg.Done()
			defer func() { <-sem }() // release slot

			// Each goroutine gets its own Worker with a unique ID so the dedup
			// store can differentiate concurrent locks.
			wcfg := s.workerCfg
			wcfg.WorkerID = s.workerID
			wcfg.TickInterval = s.cfg.TickInterval
			wcfg.Log = s.log
			w := NewWorker(wcfg)

			if err := w.RunForTenant(ctx, tid); err != nil {
				s.log.Error().Err(err).Str("tenant_id", tid).Msg("worker error")
			}
		}(tenantID)
	}

	wg.Wait()
	s.log.Info().
		Int("tenants", len(tenants)).
		Int64("cycle_ms", time.Since(cycleStart).Milliseconds()).
		Msg("precompute cycle complete")
}

// jitteredInterval returns the tick interval ±10%.
func (s *Scheduler) jitteredInterval() time.Duration {
	if s.cfg.DisableJitter {
		return s.cfg.TickInterval
	}
	base := float64(s.cfg.TickInterval)
	jitter := base * defaultJitter
	delta := (rand.Float64()*2 - 1) * jitter // uniform in [-jitter, +jitter]
	return time.Duration(base + delta)
}
