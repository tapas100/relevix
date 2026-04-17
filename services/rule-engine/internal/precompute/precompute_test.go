package precompute_test

import (
	"context"
	"testing"
	"time"

	"github.com/go-redis/redismock/v9"
	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/rule-engine/internal/engine"
	"github.com/tapas100/relevix/services/rule-engine/internal/precompute"
	"github.com/tapas100/relevix/services/rule-engine/internal/scorer"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

func nopLog() zerolog.Logger { return zerolog.Nop() }

const (
	resultsTTL = 60 * time.Second
	lockTTL    = 24 * time.Second
)

// ─── Store: TryLock ──────────────────────────────────────────────────────────

func TestStore_TryLock_Acquired(t *testing.T) {
	db, mock := redismock.NewClientMock()
	s := precompute.NewStore(db, resultsTTL, lockTTL)

	mock.ExpectSetNX("relevix:pc:lock:tenant1", "worker1", lockTTL).SetVal(true)

	ok, err := s.TryLock(context.Background(), "tenant1", "worker1")
	require.NoError(t, err)
	assert.True(t, ok)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestStore_TryLock_AlreadyHeld(t *testing.T) {
	db, mock := redismock.NewClientMock()
	s := precompute.NewStore(db, resultsTTL, lockTTL)

	mock.ExpectSetNX("relevix:pc:lock:tenant1", "worker2", lockTTL).SetVal(false)

	ok, err := s.TryLock(context.Background(), "tenant1", "worker2")
	require.NoError(t, err)
	assert.False(t, ok)
	require.NoError(t, mock.ExpectationsWereMet())
}

// ─── Store: ReadResult cache miss ────────────────────────────────────────────

func TestStore_ReadResult_Miss(t *testing.T) {
	db, mock := redismock.NewClientMock()
	s := precompute.NewStore(db, resultsTTL, lockTTL)

	mock.ExpectGet("relevix:pc:tenant42:insights").RedisNil()
	mock.ExpectGet("relevix:pc:tenant42:meta").RedisNil()

	result, err := s.ReadResult(context.Background(), "tenant42")
	require.NoError(t, err)
	assert.Nil(t, result)
}

// ─── Store: RegisterTenant / ListTenants ─────────────────────────────────────

func TestStore_RegisterAndListTenants(t *testing.T) {
	db, mock := redismock.NewClientMock()
	s := precompute.NewStore(db, resultsTTL, lockTTL)

	mock.ExpectSAdd("relevix:pc:tenants", "tenantA").SetVal(1)
	require.NoError(t, s.RegisterTenant(context.Background(), "tenantA"))

	mock.ExpectSMembers("relevix:pc:tenants").SetVal([]string{"tenantA", "tenantB"})
	tenants, err := s.ListTenants(context.Background())
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"tenantA", "tenantB"}, tenants)

	require.NoError(t, mock.ExpectationsWereMet())
}

// ─── Store: Invalidate ───────────────────────────────────────────────────────

func TestStore_Invalidate(t *testing.T) {
	db, mock := redismock.NewClientMock()
	s := precompute.NewStore(db, resultsTTL, lockTTL)

	// Invalidate uses a pipeline with two separate Del calls.
	mock.ExpectDel("relevix:pc:tenant1:insights").SetVal(1)
	mock.ExpectDel("relevix:pc:tenant1:meta").SetVal(1)

	err := s.Invalidate(context.Background(), "tenant1")
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// ─── Worker: skip when lock held ─────────────────────────────────────────────

func TestWorker_SkipsWhenLockHeld(t *testing.T) {
	db, mock := redismock.NewClientMock()
	store := precompute.NewStore(db, resultsTTL, lockTTL)

	mock.ExpectSetNX("relevix:pc:lock:tenant-x", "test-worker", lockTTL).SetVal(false)

	w := precompute.NewWorker(precompute.WorkerConfig{
		WorkerID:     "test-worker",
		Store:        store,
		Fetcher:      &precompute.StaticFetcher{},
		Rules:        &precompute.StaticRuleSource{},
		Impact:       &precompute.StaticImpactSource{},
		InfraEngine:  engine.NewInfraEngine(nil),
		Scorer:       scorer.NewDefault(),
		TickInterval: 30 * time.Second,
		Log:          nopLog(),
	})

	err := w.RunForTenant(context.Background(), "tenant-x")
	assert.NoError(t, err, "skipped lock must not be an error")
	require.NoError(t, mock.ExpectationsWereMet())
}

// ─── Worker: empty signals writes empty result ───────────────────────────────

func TestWorker_EmptySignals_WritesEmptyResult(t *testing.T) {
	db, mock := redismock.NewClientMock()
	// Allow unordered so pipeline commands can arrive in any order.
	mock.MatchExpectationsInOrder(false)
	store := precompute.NewStore(db, resultsTTL, lockTTL)

	// 1. Acquire lock.
	mock.ExpectSetNX("relevix:pc:lock:tenant-empty", "test-worker", lockTTL).SetVal(true)
	// 2. Pipeline writes — SET values are []byte from json.Marshal.
	//    Use Regexp matcher so we don't need to predict exact JSON.
	mock.Regexp().ExpectSet("relevix:pc:tenant-empty:insights", `.*`, resultsTTL).SetVal("OK")
	mock.Regexp().ExpectSet("relevix:pc:tenant-empty:meta", `.*`, resultsTTL).SetVal("OK")
	// 3. Unlock Lua script.
	mock.Regexp().ExpectEval(`.*`, []string{"relevix:pc:lock:tenant-empty"}, "test-worker").SetVal(int64(1))

	w := precompute.NewWorker(precompute.WorkerConfig{
		WorkerID:     "test-worker",
		Store:        store,
		Fetcher:      &precompute.StaticFetcher{},
		Rules:        &precompute.StaticRuleSource{},
		Impact:       &precompute.StaticImpactSource{},
		InfraEngine:  engine.NewInfraEngine(nil),
		Scorer:       scorer.NewDefault(),
		TickInterval: 30 * time.Second,
		Log:          nopLog(),
	})

	err := w.RunForTenant(context.Background(), "tenant-empty")
	assert.NoError(t, err)
}

// ─── Scheduler: TriggerNow processes tenants ────────────────────────────────

func TestScheduler_TriggerNow_ProcessesTenants(t *testing.T) {
	db, mock := redismock.NewClientMock()
	mock.MatchExpectationsInOrder(false)
	store := precompute.NewStore(db, resultsTTL, lockTTL)

	mock.ExpectSMembers("relevix:pc:tenants").SetVal([]string{"tenant-a"})
	mock.Regexp().ExpectSetNX("relevix:pc:lock:tenant-a", `.*`, lockTTL).SetVal(true)
	mock.Regexp().ExpectSet("relevix:pc:tenant-a:insights", `.*`, resultsTTL).SetVal("OK")
	mock.Regexp().ExpectSet("relevix:pc:tenant-a:meta", `.*`, resultsTTL).SetVal("OK")
	// Unlock uses redis.Script.Run which may call EvalSha or Eval.
	// Accept either; ignore unmatched unlock expectations since the exact
	// command variant depends on whether the server has cached the SHA.
	mock.Regexp().ExpectEvalSha(`.*`, []string{"relevix:pc:lock:tenant-a"}, `.*`).SetVal(int64(1))

	workerCfg := precompute.WorkerConfig{
		WorkerID:     "sched-test",
		Store:        store,
		Fetcher:      &precompute.StaticFetcher{},
		Rules:        &precompute.StaticRuleSource{},
		Impact:       &precompute.StaticImpactSource{},
		InfraEngine:  engine.NewInfraEngine(nil),
		Scorer:       scorer.NewDefault(),
		TickInterval: 30 * time.Second,
		Log:          nopLog(),
	}

	schedCfg := precompute.DefaultSchedulerConfig(nopLog())
	schedCfg.DisableJitter = true
	schedCfg.TickInterval = 10 * time.Second

	sched := precompute.NewScheduler(schedCfg, workerCfg, store)
	sched.TriggerNow(context.Background())

	require.NoError(t, mock.ExpectationsWereMet())
}

// ─── Scheduler: no tenants skips cycle ──────────────────────────────────────

func TestScheduler_NoTenants_DoesNothing(t *testing.T) {
	db, mock := redismock.NewClientMock()
	store := precompute.NewStore(db, resultsTTL, lockTTL)

	mock.ExpectSMembers("relevix:pc:tenants").SetVal([]string{})

	schedCfg := precompute.DefaultSchedulerConfig(nopLog())
	schedCfg.DisableJitter = true

	sched := precompute.NewScheduler(schedCfg, precompute.WorkerConfig{
		WorkerID: "sched-empty",
		Store:    store,
		Log:      nopLog(),
	}, store)
	sched.TriggerNow(context.Background())

	require.NoError(t, mock.ExpectationsWereMet())
}

