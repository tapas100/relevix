// Package precompute — HTTP query handler.
//
// GET /v1/insights?tenant={tenantID}
//
// Fast path  (<5 ms):  result already in Redis → return immediately.
// Slow path  (<100 ms): cache miss → run InfraEngine + scorer live, return result
//                       and fire-and-forget a background cache warm.
//
// Response shape:
//
//	{
//	  "ok": true,
//	  "from_cache": true,
//	  "computed_at": "2024-01-01T00:00:00Z",
//	  "insights": [ ...scorer.RankedInsight... ]
//	}
package precompute

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/rule-engine/internal/engine"
	"github.com/tapas100/relevix/services/rule-engine/internal/scorer"
)

// QueryHandler serves GET /v1/insights.
// It is intentionally decoupled from the chi router so it can be registered
// with any ServeMux.
type QueryHandler struct {
	store       *Store
	fetcher     SignalFetcher
	rules       RuleSource
	impact      ImpactSource
	infraEngine *engine.InfraEngine
	scorer      *scorer.Scorer
	metrics     *Metrics
	log         zerolog.Logger
}

// QueryHandlerConfig groups all dependencies for QueryHandler.
type QueryHandlerConfig struct {
	Store       *Store
	Fetcher     SignalFetcher
	Rules       RuleSource
	Impact      ImpactSource
	InfraEngine *engine.InfraEngine
	Scorer      *scorer.Scorer
	Metrics     *Metrics // may be nil — metrics are skipped if nil
	Log         zerolog.Logger
}

// NewQueryHandler constructs a QueryHandler.
func NewQueryHandler(cfg QueryHandlerConfig) *QueryHandler {
	return &QueryHandler{
		store:       cfg.Store,
		fetcher:     cfg.Fetcher,
		rules:       cfg.Rules,
		impact:      cfg.Impact,
		infraEngine: cfg.InfraEngine,
		scorer:      cfg.Scorer,
		metrics:     cfg.Metrics,
		log:         cfg.Log.With().Str("component", "query_handler").Logger(),
	}
}

// ServeHTTP implements http.Handler.
func (h *QueryHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	tenantID := r.URL.Query().Get("tenant")
	if tenantID == "" {
		h.writeError(w, http.StatusBadRequest, "MISSING_PARAM", "query param 'tenant' is required")
		return
	}

	// ── Fast path: read from Redis cache ────────────────────────────────────
	cached, err := h.store.ReadResult(r.Context(), tenantID)
	if err != nil {
		h.log.Warn().Err(err).Str("tenant_id", tenantID).Msg("cache read failed — falling back to live eval")
	}

	if cached != nil {
		if h.metrics != nil {
			h.metrics.CacheHitsTotal.Inc()
		}
		h.log.Debug().
			Str("tenant_id", tenantID).
			Int64("latency_ms", time.Since(start).Milliseconds()).
			Msg("cache hit")
		h.writeInsights(w, cached.Insights, true, cached.Meta.ComputedAt)
		return
	}

	// ── Slow path: live evaluation ───────────────────────────────────────────
	if h.metrics != nil {
		h.metrics.CacheMissesTotal.Inc()
	}

	insights, computedAt, err := h.liveEval(r.Context(), tenantID)
	if err != nil {
		h.log.Error().Err(err).Str("tenant_id", tenantID).Msg("live eval failed")
		h.writeError(w, http.StatusInternalServerError, "EVAL_ERROR", "evaluation failed")
		return
	}

	h.log.Info().
		Str("tenant_id", tenantID).
		Int64("latency_ms", time.Since(start).Milliseconds()).
		Int("insights", len(insights)).
		Msg("cache miss — live eval complete")

	h.writeInsights(w, insights, false, computedAt)

	// Fire-and-forget background cache warm so the next request is fast.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := h.warmCache(ctx, tenantID, insights, computedAt, start); err != nil {
			h.log.Warn().Err(err).Str("tenant_id", tenantID).Msg("background cache warm failed")
		}
	}()
}

// liveEval runs the full evaluation pipeline synchronously.
func (h *QueryHandler) liveEval(ctx context.Context, tenantID string) ([]scorer.RankedInsight, time.Time, error) {
	computedAt := time.Now()

	signals, err := h.fetcher.Fetch(ctx, tenantID)
	if err != nil {
		return nil, computedAt, err
	}

	rules, err := h.rules.RulesForTenant(ctx, tenantID)
	if err != nil {
		return nil, computedAt, err
	}

	// Build a lookup: ruleID → priority.
	rulePriority := make(map[string]int, len(rules))
	for _, rule := range rules {
		rulePriority[rule.ID] = rule.Priority
	}

	var insights []scorer.Insight
	for _, sig := range signals {
		resp := h.infraEngine.Evaluate(sig, "live")
		for _, m := range resp.Matches {
			if m.Suppressed {
				continue
			}
			imp, _ := h.impact.ImpactFor(ctx, tenantID, sig)
			si := scorer.FromRuleMatch(m, rulePriority[m.RuleID], scorer.ImpactInput{
				AffectedServiceCount: imp.AffectedServiceCount,
				RequestsPerSecond:    imp.RequestsPerSecond,
				IsUserFacing:         imp.IsUserFacing,
				ExplicitScore:        imp.ExplicitScore,
			})
			insights = append(insights, si)
		}
	}

	ranked := h.scorer.Rank(insights)
	return ranked, computedAt, nil
}

// warmCache writes the results from a live eval back to Redis.
func (h *QueryHandler) warmCache(
	ctx context.Context,
	tenantID string,
	insights []scorer.RankedInsight,
	computedAt time.Time,
	start time.Time,
) error {
	meta := CacheMetadata{
		WorkerID:     "query-handler/live",
		ComputedAt:   computedAt,
		DurationMS:   time.Since(start).Milliseconds(),
		InsightCount: len(insights),
	}
	return h.store.WriteResult(ctx, meta, insights)
}

// ─── response helpers ─────────────────────────────────────────────────────────

type insightsResponse struct {
	OK          bool                   `json:"ok"`
	FromCache   bool                   `json:"from_cache"`
	ComputedAt  time.Time              `json:"computed_at"`
	Insights    []scorer.RankedInsight `json:"insights"`
}

func (h *QueryHandler) writeInsights(
	w http.ResponseWriter,
	insights []scorer.RankedInsight,
	fromCache bool,
	computedAt time.Time,
) {
	resp := insightsResponse{
		OK:         true,
		FromCache:  fromCache,
		ComputedAt: computedAt,
		Insights:   insights,
	}
	if resp.Insights == nil {
		resp.Insights = []scorer.RankedInsight{}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

func (h *QueryHandler) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": false,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}
