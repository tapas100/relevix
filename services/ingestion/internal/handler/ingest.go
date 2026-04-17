// Package handler provides the HTTP intake endpoints for the ingestion service.
//
// Backpressure design:
//   The handler writes accepted logs directly into the bounded intakeCh channel.
//   If the channel is at capacity (pipeline is overwhelmed), the handler
//   immediately returns HTTP 503 — the upstream caller must retry with backoff.
//   This prevents the HTTP layer from absorbing unbounded memory.
package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/metrics"
)

var validate = validator.New()

// IngestBatch handles POST /v1/ingest/batch
//
// The endpoint is intentionally thin:
//  1. Decode + validate the request body.
//  2. Stamp ReceivedAt and Source.
//  3. Try-send each log into the intake channel.
//  4. Respond with per-log accept/reject summary.
//
// It never blocks on a full channel — excess logs are rejected with
// a "backpressure" reason, and the caller gets a partial-accept response.
func IngestBatch(log zerolog.Logger, intakeCh chan<- *domain.RawLog, maxBatch int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req domain.BatchRequest

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid JSON body", nil)
			return
		}

		if err := validate.Struct(req); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error(), nil)
			return
		}

		if len(req.Logs) > maxBatch {
			writeError(w, http.StatusRequestEntityTooLarge, "INGEST_BATCH_TOO_LARGE",
				"batch exceeds maximum allowed size", map[string]int{"max": maxBatch})
			return
		}

		now := time.Now().UTC()
		accepted := 0
		rejections := make([]domain.Rejection, 0)

		for i := range req.Logs {
			raw := &req.Logs[i]
			raw.Source = domain.SourceHTTP
			raw.ReceivedAt = now

			// Non-blocking send — returns immediately if channel is full.
			select {
			case intakeCh <- raw:
				accepted++
				metrics.LogsReceivedTotal.WithLabelValues("http", raw.TenantID).Inc()
			default:
				// Pipeline is at capacity — apply backpressure to the caller.
				rejections = append(rejections, domain.Rejection{
					Index:  i,
					Reason: "backpressure: intake queue full",
				})
				metrics.LogsRejectedTotal.WithLabelValues("http", "backpressure").Inc()
			}
		}

		// Update channel utilization gauge.
		metrics.IntakeChannelUtilization.Set(float64(len(intakeCh)) / float64(cap(intakeCh)))

		status := http.StatusAccepted
		if accepted == 0 {
			status = http.StatusServiceUnavailable
		}

		log.Info().
			Int("accepted", accepted).
			Int("rejected", len(rejections)).
			Msg("batch ingested")

		writeJSON(w, status, map[string]any{
			"ok": accepted > 0,
			"data": domain.BatchResponse{
				Accepted:   accepted,
				Rejected:   len(rejections),
				Rejections: rejections,
			},
		})
	}
}

// Health handles GET /health
func Health() http.HandlerFunc {
	start := time.Now()
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"uptime": int(time.Since(start).Seconds()),
			"checks": map[string]any{"self": map[string]any{"status": "ok"}},
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string, details any) {
	writeJSON(w, status, map[string]any{
		"ok": false,
		"error": map[string]any{"code": code, "message": message, "details": details},
	})
}
