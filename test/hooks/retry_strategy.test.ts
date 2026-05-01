/**
 * Unit tests for `RetryStrategy` and the default `ExponentialBackoffStrategy`.
 *
 * The strategy is a plug-in: given an attempt counter and the wrapped
 * `TraceworksError`, it returns either a delay in milliseconds (caller sleeps then
 * retries) or `null` (caller gives up and rethrows). The dispatcher owns the
 * sleep + the loop; the strategy owns only the policy decision.
 *
 * The tests cover:
 *   - per-error-type policy (Auth / RateLimit / ProviderError(retryable) /
 *     ModelTimeoutError / unknown TraceworksError subclasses).
 *   - maxAttempts cap across every retryable variant.
 *   - jitter math via an injected `randomFn`.
 *   - the exponential cap at 30s.
 *   - `RateLimitError.retryAfterMs` taking precedence over computed backoff.
 *   - `backoff: "linear"` (no jitter) and `backoff: "none"` modes.
 *   - the `NO_RETRY` sentinel.
 */

import { describe, expect, it } from "vitest";
import {
  AuthError,
  ModelTimeoutError,
  ProviderError,
  RateLimitError,
  SchemaValidationError,
} from "../../src/errors/index.js";
import {
  ExponentialBackoffStrategy,
  NO_RETRY,
  type RetryStrategy,
} from "../../src/hooks/retry_strategy.js";
import { testConfig } from "../_helpers/test_config.js";

const baseConfig = testConfig().retry;

describe("NO_RETRY", () => {
  it("returns null on every call", () => {
    expect(NO_RETRY.decide(1, new RateLimitError("slow", 100))).toBeNull();
    expect(NO_RETRY.decide(99, new ProviderError("boom", "anthropic"))).toBeNull();
  });
});

describe("ExponentialBackoffStrategy: per-error policy", () => {
  it("never retries on AuthError, even on attempt 1", () => {
    const s: RetryStrategy = new ExponentialBackoffStrategy({ config: baseConfig });
    expect(s.decide(1, new AuthError("bad key"))).toBeNull();
    expect(s.decide(2, new AuthError("bad key"))).toBeNull();
  });

  it("returns RateLimitError.retryAfterMs verbatim, ignoring the computed backoff", () => {
    // randomFn fixed to 1.0 means the computed backoff for attempt 1 would be
    // initialDelayMs (500). The retryAfterMs (250) wins regardless.
    const s = new ExponentialBackoffStrategy({
      config: baseConfig,
      randomFn: () => 1.0,
    });
    expect(s.decide(1, new RateLimitError("slow", 250))).toBe(250);
  });

  it("falls back to computed backoff when RateLimitError carries no retryAfterMs", () => {
    const s = new ExponentialBackoffStrategy({
      config: baseConfig,
      randomFn: () => 1.0,
    });
    // attempt=1 -> initialDelayMs * 2^0 = 500ms, jitter factor 1.0 -> 500ms.
    expect(s.decide(1, new RateLimitError("slow"))).toBe(500);
  });

  it("retries ProviderError when retryable=true (the default)", () => {
    const s = new ExponentialBackoffStrategy({
      config: baseConfig,
      randomFn: () => 1.0,
    });
    expect(s.decide(1, new ProviderError("upstream 500", "anthropic"))).toBe(500);
  });

  it("rethrows ProviderError when retryable=false", () => {
    const s = new ExponentialBackoffStrategy({ config: baseConfig });
    const err = new ProviderError("client bug", "anthropic", undefined, false);
    expect(s.decide(1, err)).toBeNull();
  });

  it("retries ModelTimeoutError up to floor(maxAttempts/2) total attempts", () => {
    // maxAttempts=4 -> cap = floor(4/2) = 2. After attempt 1 fails (1 < 2)
    // we still have budget; after attempt 2 fails (2 >= 2) we must give up.
    const s = new ExponentialBackoffStrategy({
      config: { maxAttempts: 4, backoff: "exponential", initialDelayMs: 500 },
      randomFn: () => 1.0,
    });
    const err = new ModelTimeoutError("slow", 30_000);
    expect(s.decide(1, err)).toBe(500);
    expect(s.decide(2, err)).toBeNull();
  });

  it("ModelTimeoutError gives up immediately when default maxAttempts=3 (cap=1)", () => {
    // floor(3/2) = 1: a single attempt is the entire budget, so the first
    // failure exhausts retries. Documented behavior; deliberate trade-off
    // because timeouts are usually deterministic.
    const s = new ExponentialBackoffStrategy({ config: baseConfig });
    expect(s.decide(1, new ModelTimeoutError("slow", 30_000))).toBeNull();
  });

  it("returns null for unknown TraceworksError subclasses (e.g. SchemaValidationError)", () => {
    const s = new ExponentialBackoffStrategy({ config: baseConfig });
    expect(s.decide(1, new SchemaValidationError("bad", "Person", {}))).toBeNull();
  });
});

describe("ExponentialBackoffStrategy: maxAttempts cap", () => {
  it("returns null once attempt reaches maxAttempts on RateLimitError", () => {
    const s = new ExponentialBackoffStrategy({ config: baseConfig });
    expect(s.decide(3, new RateLimitError("slow", 100))).toBeNull();
  });

  it("returns null once attempt reaches maxAttempts on retryable ProviderError", () => {
    const s = new ExponentialBackoffStrategy({ config: baseConfig });
    expect(s.decide(3, new ProviderError("upstream 500", "anthropic"))).toBeNull();
  });
});

describe("ExponentialBackoffStrategy: backoff math", () => {
  it("uses full-jitter formula: jitter * min(initialDelayMs * 2^(attempt-1), 30000)", () => {
    const s = new ExponentialBackoffStrategy({
      config: { maxAttempts: 5, backoff: "exponential", initialDelayMs: 1_000 },
      randomFn: () => 0.5,
    });
    // attempt=1 -> base=1000*2^0=1000, jitter=0.5 -> 500
    // attempt=2 -> base=1000*2^1=2000, jitter=0.5 -> 1000
    // attempt=3 -> base=1000*2^2=4000, jitter=0.5 -> 2000
    expect(s.decide(1, new ProviderError("x", "anthropic"))).toBe(500);
    expect(s.decide(2, new ProviderError("x", "anthropic"))).toBe(1_000);
    expect(s.decide(3, new ProviderError("x", "anthropic"))).toBe(2_000);
  });

  it("caps the exponential base at 30 seconds", () => {
    // initialDelayMs=10s and attempt=8 would compute 10s * 2^7 = 1280s without
    // the cap. With the cap, base = 30_000ms, jitter 1.0 -> 30_000ms.
    const s = new ExponentialBackoffStrategy({
      config: { maxAttempts: 100, backoff: "exponential", initialDelayMs: 10_000 },
      randomFn: () => 1.0,
    });
    expect(s.decide(8, new ProviderError("x", "anthropic"))).toBe(30_000);
  });

  it("'linear' mode returns initialDelayMs constant, no jitter applied", () => {
    const s = new ExponentialBackoffStrategy({
      config: { maxAttempts: 5, backoff: "linear", initialDelayMs: 250 },
      randomFn: () => 0.0, // would zero-out jittered output; linear ignores it
    });
    expect(s.decide(1, new ProviderError("x", "anthropic"))).toBe(250);
    expect(s.decide(2, new ProviderError("x", "anthropic"))).toBe(250);
  });

  it("'none' mode never retries (returns null immediately on attempt 1)", () => {
    const s = new ExponentialBackoffStrategy({
      config: { maxAttempts: 5, backoff: "none", initialDelayMs: 250 },
    });
    expect(s.decide(1, new ProviderError("x", "anthropic"))).toBeNull();
    // RateLimitError still honors retryAfterMs in 'none' mode, because the
    // user supplied an explicit hint - ignoring it would be surprising.
    expect(s.decide(1, new RateLimitError("slow", 100))).toBe(100);
  });
});
