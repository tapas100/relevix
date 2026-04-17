package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
	"github.com/tapas100/relevix/services/rule-engine/internal/engine"
)

var validate = validator.New()

// Evaluate handles POST /v1/rules/evaluate
// It decodes the request, fetches the tenant's rules, and runs the evaluator.
func Evaluate(log zerolog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req domain.EvaluationRequest

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid JSON body", nil)
			return
		}

		if err := validate.Struct(req); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error(), nil)
			return
		}

		// TODO: load rules from repository (injected via closure in real impl)
		// Stub: empty rule set
		rules := []domain.Rule{}

		resp := engine.Evaluate(rules, req)

		log.Info().
			Str("tenantId", req.TenantID).
			Str("traceId", resp.TraceID).
			Int("matched", resp.MatchedCount).
			Int64("evalMs", resp.EvaluationTimeMs).
			Msg("evaluation complete")

		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": resp})
	}
}

// Health handles GET /health
func Health(cfg interface{ Addr() string }) http.HandlerFunc {
	start := time.Now()
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"uptime": int(time.Since(start).Seconds()),
			"checks": map[string]any{"self": map[string]any{"status": "ok"}},
		})
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string, details any) {
	writeJSON(w, status, map[string]any{
		"ok": false,
		"error": map[string]any{
			"code":    code,
			"message": message,
			"details": details,
		},
	})
}
