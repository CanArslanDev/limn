/**
 * Retry policy for the `HookDispatcher`. Hooks themselves are observers and
 * cannot alter control flow, so the dispatcher consults a `RetryStrategy`
 * between attempts and either sleeps + retries or rethrows.
 *
 * Why a separate primitive (vs. a "RetryHook"): hooks fan-out per phase;
 * retry is a single decision per attempt that drives the loop. Conflating the
 * two would force every hook to know about retry semantics or force the
 * dispatcher to treat one hook as special. A dedicated `RetryStrategy` keeps
 * hooks pure observers and gives retry one clearly-named seat.
 *
 * The strategy interface is one method (`decide`) that returns either a delay
 * in milliseconds (caller sleeps then retries) or `null` (caller gives up and
 * rethrows the original error). The dispatcher owns the sleep + the loop;
 * the strategy owns only the policy.
 *
 * Per-error policy on the default `ExponentialBackoffStrategy`:
 *   - `AuthError`: never retry. Bad keys never become good by waiting.
 *   - `RateLimitError`: honor `retryAfterMs` if present; otherwise computed
 *     backoff. Cap by `maxAttempts`.
 *   - `ProviderError`: retry only when `retryable === true` (5xx + transport).
 *     The Anthropic adapter sets `retryable: false` for 4xx client faults and
 *     for caller-bug guards so the strategy gives up immediately.
 *   - `ModelTimeoutError`: retry up to `floor(maxAttempts/2)` attempts.
 *     Timeouts are usually deterministic (the request really is too slow);
 *     halving the budget caps the worst-case wall time without losing the
 *     occasional transient hiccup.
 *   - Any other `TraceworksError` (SchemaValidationError, ToolExecutionError):
 *     return null. The retry layer is for transport-level recovery; logical
 *     failures escalate to the caller.
 *
 * Backoff math is full-jitter (per AWS retry guidance):
 *   delay = randomFn() * min(initialDelayMs * 2^(attempt-1), 30_000)
 * Capped at 30 seconds so a runaway attempt counter cannot wedge a request.
 *
 * `randomFn` is injectable so tests can pin jitter to a fixed factor and
 * assert exact delay values. Production omits the option; `Math.random` is
 * used.
 */

import type { RetryConfig } from "../config/traceworks_config.js";
import {
  AuthError,
  ModelTimeoutError,
  ProviderError,
  RateLimitError,
  type TraceworksError,
} from "../errors/index.js";

/**
 * Policy plug-in consulted by `HookDispatcher` between attempts.
 */
export interface RetryStrategy {
  /**
   * Decide what to do after an attempt threw. Returns the delay in
   * milliseconds before the next attempt, or `null` to give up and rethrow.
   * `attempt` is the 1-based counter of the attempt that just failed.
   */
  decide(attempt: number, err: TraceworksError): number | null;
}

/**
 * Strategy that never retries. Used as the dispatcher's default so the batch
 * 1.1 behavior (run exec exactly once) is preserved when no retry strategy
 * is supplied. Tests that exercise the no-retry path also pass this in
 * explicitly to make the intent obvious.
 */
export const NO_RETRY: RetryStrategy = { decide: () => null };

// Hard ceiling on a single computed delay. Promoting this to `RetryConfig`
// is deferred (batch-1.3 review item I2): no concrete user need yet, and the
// 30s cap matches the README copy. Revisit when a Layer 1 caller asks to
// tune it.
const MAX_BACKOFF_MS = 30_000;

export interface ExponentialBackoffOptions {
  readonly config: RetryConfig;
  /**
   * Random number in [0, 1). Defaults to `Math.random`. Tests inject a fixed
   * function (e.g. `() => 0.5`) so jittered delays are deterministic.
   */
  readonly randomFn?: () => number;
}

/**
 * Default retry strategy. Honors the per-error policy documented at module
 * top, with backoff math driven by the supplied `RetryConfig`.
 */
export class ExponentialBackoffStrategy implements RetryStrategy {
  private readonly config: RetryConfig;
  private readonly randomFn: () => number;

  public constructor(options: ExponentialBackoffOptions) {
    this.config = options.config;
    this.randomFn = options.randomFn ?? Math.random;
  }

  public decide(attempt: number, err: TraceworksError): number | null {
    if (err instanceof AuthError) return null;

    if (err instanceof RateLimitError) {
      // RateLimitError honors `retryAfterMs` even in `backoff: "none"` mode:
      // the provider supplied an explicit hint, ignoring it would surprise
      // users and overload the upstream. The maxAttempts cap still applies.
      if (attempt >= this.config.maxAttempts) return null;
      if (err.retryAfterMs !== undefined) return err.retryAfterMs;
      return this.computeBackoff(attempt);
    }

    if (err instanceof ProviderError) {
      if (!err.retryable) return null;
      if (attempt >= this.config.maxAttempts) return null;
      return this.computeBackoff(attempt);
    }

    if (err instanceof ModelTimeoutError) {
      const cap = Math.floor(this.config.maxAttempts / 2);
      if (attempt >= cap) return null;
      return this.computeBackoff(attempt);
    }

    return null;
  }

  /**
   * Compute the delay before the next attempt according to `backoff` mode.
   * Returns `null` for `"none"` (which makes `decide` give up on computed-
   * backoff paths). The RateLimitError branch above bypasses this when it
   * has an explicit `retryAfterMs`.
   */
  private computeBackoff(attempt: number): number | null {
    switch (this.config.backoff) {
      case "none":
        return null;
      case "linear":
        // Constant delay, no jitter. The user opted out of randomization.
        return this.config.initialDelayMs;
      case "exponential": {
        // Full-jitter: `Math.floor(randomFn() * exp)` can return 0 when
        // `randomFn()` is near zero. Documented in batch-1.3 review (item
        // M1); a dedicated 0ms-jitter test was deferred since the math is
        // already exercised by the strategy unit tests.
        const exp = Math.min(this.config.initialDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        return Math.floor(this.randomFn() * exp);
      }
    }
  }
}
