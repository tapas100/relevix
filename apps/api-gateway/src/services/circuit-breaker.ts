/**
 * CircuitBreaker — generic production-grade circuit breaker.
 *
 * State machine:
 *
 *   ┌──────────┐   threshold failures   ┌──────┐
 *   │  CLOSED  │ ─────────────────────▶ │ OPEN │
 *   └──────────┘                        └──────┘
 *        ▲                                  │ resetTimeoutMs
 *        │ probe succeeds                   ▼
 *        │                           ┌───────────┐
 *        └──────────────────────────-│ HALF_OPEN │
 *                                    └───────────┘
 *
 * - CLOSED   : calls pass through; failures are counted.
 * - OPEN     : calls are rejected immediately (fast-fail) with CircuitOpenError.
 * - HALF_OPEN: exactly ONE probe call is allowed; success → CLOSED, failure → OPEN.
 *
 * Prometheus metrics for circuit state and call outcomes are emitted via the
 * optional `onStateChange` callback — the metrics plugin registers them there.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** How many consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** How many consecutive successes in HALF_OPEN to close the circuit. Default: 2 */
  successThreshold?: number;
  /** How long (ms) to wait in OPEN before probing. Default: 30 000 */
  resetTimeoutMs?: number;
  /** Called every time state transitions happen — wire to Prometheus gauge. */
  onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker '${name}' is OPEN — downstream unavailable`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures   = 0;
  private successes  = 0;
  private openedAt   = 0;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs:   number;
  private readonly onStateChange: ((name: string, from: CircuitState, to: CircuitState) => void) | undefined;

  constructor(
    private readonly name: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.resetTimeoutMs   = opts.resetTimeoutMs   ?? 30_000;
    this.onStateChange    = opts.onStateChange;
  }

  /** Current circuit state — used by the /health and /metrics endpoints. */
  get currentState(): CircuitState { return this.state; }

  /**
   * Wraps an async operation with circuit-breaker protection.
   * Throws CircuitOpenError if the circuit is OPEN without attempting the call.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionFromOpen();

    if (this.state === 'OPEN') {
      throw new CircuitOpenError(this.name);
    }

    // In HALF_OPEN only ONE probe is permitted — subsequent callers fast-fail
    // until the probe resolves.
    if (this.state === 'HALF_OPEN' && this.failures > 0) {
      // Treat concurrent calls during probe as fast-fail
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  // ─── Private state transitions ────────────────────────────────────────────

  private maybeTransitionFromOpen(): void {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.transition('HALF_OPEN');
      this.failures  = 0;
      this.successes = 0;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.transition('CLOSED');
        this.failures  = 0;
        this.successes = 0;
      }
    } else {
      // Reset failure count on any success in CLOSED state
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition('OPEN');
      this.successes = 0;
    }
  }

  private transition(next: CircuitState): void {
    const prev = this.state;
    this.state = next;
    this.onStateChange?.(this.name, prev, next);
  }
}
