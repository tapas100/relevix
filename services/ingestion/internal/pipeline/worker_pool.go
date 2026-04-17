// WorkerPool spins up cfg.WorkerCount goroutines that each read a RawLog
// from in, normalize it, and write the NormalizedLog to out.
//
// Scaling: each worker is independent. Increasing WorkerCount linearly
// scales normalization throughput up to CPU core count.
package pipeline

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/metrics"
)

// WorkerPool manages the normalize-and-enrich workers.
type WorkerPool struct {
	in         <-chan *domain.RawLog
	out        chan<- *domain.NormalizedLog
	normalizer *Normalizer
	workers    int
	log        zerolog.Logger
}

// NewWorkerPool creates a WorkerPool.
//   in      — raw log stream from intake
//   out     — normalized log stream to batcher
//   workers — number of concurrent goroutines
func NewWorkerPool(
	in <-chan *domain.RawLog,
	out chan<- *domain.NormalizedLog,
	normalizer *Normalizer,
	workers int,
	log zerolog.Logger,
) *WorkerPool {
	return &WorkerPool{
		in:         in,
		out:        out,
		normalizer: normalizer,
		workers:    workers,
		log:        log.With().Str("component", "worker_pool").Logger(),
	}
}

// Run launches all workers and blocks until all of them exit.
// Workers exit when ctx is cancelled or in is closed.
func (p *WorkerPool) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(p.workers)

	for i := range p.workers {
		go func(id int) {
			defer wg.Done()
			p.work(ctx, id)
		}(i)
	}

	p.log.Info().Int("workers", p.workers).Msg("worker pool started")
	wg.Wait()
	p.log.Info().Msg("worker pool stopped")
}

func (p *WorkerPool) work(ctx context.Context, id int) {
	for {
		select {
		case <-ctx.Done():
			return
		case raw, ok := <-p.in:
			if !ok {
				return
			}
			start := time.Now()
			normalized := p.normalizer.Normalize(raw)
			metrics.NormalizeDurationSeconds.Observe(time.Since(start).Seconds())

			// Blocking send — backpressure propagates to intake if batcher is slow.
			select {
			case p.out <- normalized:
			case <-ctx.Done():
				return
			}
		}
	}
}
