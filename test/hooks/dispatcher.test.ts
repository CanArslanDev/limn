/**
 * Unit tests for the `HookDispatcher`. Covers the five lifecycle phases, the
 * "hook errors do not crash the call" contract, the read-only context shape
 * passed to each phase, and (since batch 1.3) the retry strategy integration:
 * multi-attempt loops, `attempt` counter bumping, `onRetry` firing between
 * attempts, and the injectable `sleepFn`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, ProviderError, RateLimitError } from "../../src/errors/index.js";
import { type Hook, HookDispatcher, newTraceId } from "../../src/hooks/dispatcher.js";
import { ExponentialBackoffStrategy, type RetryStrategy } from "../../src/hooks/retry_strategy.js";
import { testConfig } from "../_helpers/test_config.js";

const baseCtx = {
  traceId: "trc_test",
  model: "claude-sonnet-4-6" as const,
  messages: [{ role: "user" as const, content: "hi" }],
};

const okResult = { content: "hello", inputTokens: 1, outputTokens: 1 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HookDispatcher", () => {
  it("runs exec and returns its result when no hooks are registered", async () => {
    const dispatcher = new HookDispatcher();
    const out = await dispatcher.run(baseCtx, async () => okResult);
    expect(out).toEqual(okResult);
  });

  it("fires onCallStart -> exec -> onCallSuccess -> onCallEnd in order on success", async () => {
    const order: string[] = [];
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        order.push("start");
      },
      onCallSuccess: () => {
        order.push("success");
      },
      onCallError: () => {
        order.push("error");
      },
      onCallEnd: () => {
        order.push("end");
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await dispatcher.run(baseCtx, async () => {
      order.push("exec");
      return okResult;
    });
    expect(order).toEqual(["start", "exec", "success", "end"]);
  });

  it("fires onCallStart -> exec -> onCallError -> onCallEnd on failure and rethrows", async () => {
    const order: string[] = [];
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        order.push("start");
      },
      onCallSuccess: () => {
        order.push("success");
      },
      onCallError: () => {
        order.push("error");
      },
      onCallEnd: () => {
        order.push("end");
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    const boom = new ProviderError("boom", "anthropic");
    await expect(
      dispatcher.run(baseCtx, async () => {
        order.push("exec");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(order).toEqual(["start", "exec", "error", "end"]);
  });

  it("a throwing hook does not crash the call; warning is logged and other hooks still fire", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const startedB: string[] = [];
    const bad: Hook = {
      name: "bad",
      onCallStart: () => {
        throw new Error("hook exploded");
      },
    };
    const good: Hook = {
      name: "good",
      onCallStart: () => {
        startedB.push("good");
      },
    };
    const dispatcher = new HookDispatcher([bad, good]);
    await dispatcher.run(baseCtx, async () => okResult);
    expect(startedB).toEqual(["good"]);
    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0];
    expect(firstCall?.[0]).toMatch(/hook "bad" failed in onCallStart/);
  });

  it("populates ctx.response in the onCallSuccess phase", async () => {
    let captured: { content?: string | undefined } | undefined;
    const hook: Hook = {
      name: "capture",
      onCallSuccess: (ctx) => {
        captured = { content: ctx.response?.content };
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await dispatcher.run(baseCtx, async () => okResult);
    expect(captured).toEqual({ content: "hello" });
  });

  it("populates ctx.error in the onCallError phase", async () => {
    let capturedCode: string | undefined;
    const hook: Hook = {
      name: "capture",
      onCallError: (ctx) => {
        capturedCode = ctx.error?.code;
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw new ProviderError("boom", "anthropic");
      }),
    ).rejects.toThrow();
    expect(capturedCode).toBe("PROVIDER_ERROR");
  });

  it("attempt counter starts at 1", async () => {
    let observedAttempt = 0;
    const hook: Hook = {
      name: "spy",
      onCallStart: (ctx) => {
        observedAttempt = ctx.attempt;
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await dispatcher.run(baseCtx, async () => okResult);
    expect(observedAttempt).toBe(1);
  });

  it("preserves TraceworksError subclasses (RateLimitError) on ctx.error without re-wrapping", async () => {
    let capturedError: unknown;
    let capturedCode: string | undefined;
    const hook: Hook = {
      name: "capture",
      onCallError: (ctx) => {
        capturedError = ctx.error;
        capturedCode = ctx.error?.code;
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    const rateLimit = new RateLimitError("slow down", 250);
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw rateLimit;
      }),
    ).rejects.toBe(rateLimit);
    expect(capturedError).toBeInstanceOf(RateLimitError);
    expect(capturedCode).toBe("RATE_LIMIT");
  });

  it("wraps non-TraceworksError throws into a ProviderError when populating ctx.error", async () => {
    let capturedCode: string | undefined;
    const hook: Hook = {
      name: "capture",
      onCallError: (ctx) => {
        capturedCode = ctx.error?.code;
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw new Error("plain error");
      }),
    ).rejects.toThrow("plain error");
    expect(capturedCode).toBe("PROVIDER_ERROR");
  });

  it("newTraceId() returns a trc_-prefixed string", () => {
    const id = newTraceId();
    expect(id.startsWith("trc_")).toBe(true);
    expect(id.length).toBeGreaterThan("trc_".length);
  });

  it("backward-compat: legacy `new HookDispatcher([hook])` array form still works", async () => {
    const order: string[] = [];
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        order.push("start");
      },
      onCallSuccess: () => {
        order.push("success");
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await dispatcher.run(baseCtx, async () => okResult);
    expect(order).toEqual(["start", "success"]);
  });
});

describe("HookDispatcher retry integration", () => {
  // Always-retry-once strategy: on attempt 1, sleep 10ms; on later attempts,
  // give up. Lets tests assert the dispatcher loop drives exec exactly twice
  // without depending on the per-error policy of ExponentialBackoffStrategy.
  const retryOnce: RetryStrategy = {
    decide: (attempt) => (attempt === 1 ? 10 : null),
  };

  function recordingSleep(): {
    sleepFn: (ms: number) => Promise<void>;
    delays: number[];
  } {
    const delays: number[] = [];
    return {
      delays,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    };
  }

  it("calls exec multiple times when the strategy returns a delay", async () => {
    const { sleepFn, delays } = recordingSleep();
    const dispatcher = new HookDispatcher({ retry: retryOnce, sleepFn });
    let calls = 0;
    const result = await dispatcher.run(baseCtx, async () => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderError("transient", "anthropic");
      }
      return okResult;
    });
    expect(calls).toBe(2);
    expect(delays).toEqual([10]);
    expect(result).toEqual(okResult);
  });

  it("bumps the attempt counter on HookContext between retries", async () => {
    const { sleepFn } = recordingSleep();
    const observed: number[] = [];
    const hook: Hook = {
      name: "spy",
      onRetry: (ctx) => {
        observed.push(ctx.attempt);
      },
    };
    const dispatcher = new HookDispatcher({
      hooks: [hook],
      retry: retryOnce,
      sleepFn,
    });
    let calls = 0;
    await dispatcher.run(baseCtx, async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError("transient", "anthropic");
      return okResult;
    });
    // onRetry fires once between attempt 1 (failed) and attempt 2 (succeeded).
    // The attempt counter on that context reflects the upcoming attempt (2).
    expect(observed).toEqual([2]);
  });

  it("fires onRetry between attempts but not before attempt 1", async () => {
    const { sleepFn } = recordingSleep();
    const order: string[] = [];
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        order.push("start");
      },
      onRetry: () => {
        order.push("retry");
      },
      onCallSuccess: () => {
        order.push("success");
      },
      onCallEnd: () => {
        order.push("end");
      },
    };
    const dispatcher = new HookDispatcher({
      hooks: [hook],
      retry: retryOnce,
      sleepFn,
    });
    let calls = 0;
    await dispatcher.run(baseCtx, async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError("transient", "anthropic");
      return okResult;
    });
    // onCallStart fires once for the entire call (not per-attempt). onRetry
    // fires before each retry. onCallSuccess + onCallEnd close the lifecycle.
    expect(order).toEqual(["start", "retry", "success", "end"]);
  });

  it("on final failure: onCallStart once, onCallError once, onCallEnd once", async () => {
    const { sleepFn } = recordingSleep();
    const counts = { start: 0, retry: 0, success: 0, error: 0, end: 0 };
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        counts.start += 1;
      },
      onRetry: () => {
        counts.retry += 1;
      },
      onCallSuccess: () => {
        counts.success += 1;
      },
      onCallError: () => {
        counts.error += 1;
      },
      onCallEnd: () => {
        counts.end += 1;
      },
    };
    const dispatcher = new HookDispatcher({
      hooks: [hook],
      retry: retryOnce,
      sleepFn,
    });
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw new ProviderError("always boom", "anthropic");
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    // retryOnce gives up on attempt 2; so exec is called twice and onRetry
    // fires once. Lifecycle hooks each fire exactly once at the bookends.
    expect(counts).toEqual({ start: 1, retry: 1, success: 0, error: 1, end: 1 });
  });

  it("on success after retry: onCallStart once, onCallSuccess once, onCallEnd once, onRetry attempts-1 times", async () => {
    const { sleepFn } = recordingSleep();
    const counts = { start: 0, retry: 0, success: 0, error: 0, end: 0 };
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        counts.start += 1;
      },
      onRetry: () => {
        counts.retry += 1;
      },
      onCallSuccess: () => {
        counts.success += 1;
      },
      onCallError: () => {
        counts.error += 1;
      },
      onCallEnd: () => {
        counts.end += 1;
      },
    };
    const dispatcher = new HookDispatcher({
      hooks: [hook],
      retry: retryOnce,
      sleepFn,
    });
    let calls = 0;
    await dispatcher.run(baseCtx, async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError("transient", "anthropic");
      return okResult;
    });
    expect(counts).toEqual({ start: 1, retry: 1, success: 1, error: 0, end: 1 });
  });

  it("rethrows immediately and does not sleep when the strategy returns null on attempt 1", async () => {
    const { sleepFn, delays } = recordingSleep();
    const dispatcher = new HookDispatcher({
      retry: new ExponentialBackoffStrategy({ config: testConfig().retry }),
      sleepFn,
    });
    const auth = new AuthError("bad key");
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw auth;
      }),
    ).rejects.toBe(auth);
    expect(delays).toEqual([]);
  });

  it("invokes the injected sleepFn with the strategy's delay", async () => {
    const { sleepFn, delays } = recordingSleep();
    // Custom strategy that returns predictable delays per attempt.
    const stepped: RetryStrategy = {
      decide: (attempt) => (attempt === 1 ? 100 : attempt === 2 ? 200 : null),
    };
    const dispatcher = new HookDispatcher({ retry: stepped, sleepFn });
    let calls = 0;
    await expect(
      dispatcher.run(baseCtx, async () => {
        calls += 1;
        throw new ProviderError("nope", "anthropic");
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("preserves the original throw on rethrow (not the TraceworksError wrapper) after retries", async () => {
    const { sleepFn } = recordingSleep();
    const dispatcher = new HookDispatcher({ retry: retryOnce, sleepFn });
    const original = new ProviderError("boom", "anthropic");
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("bumps ctx.attempt visible to onCallSuccess when the success arrives mid-loop", async () => {
    const { sleepFn } = recordingSleep();
    let observedSuccessAttempt = 0;
    const hook: Hook = {
      name: "spy",
      onCallSuccess: (ctx) => {
        observedSuccessAttempt = ctx.attempt;
      },
    };
    const dispatcher = new HookDispatcher({
      hooks: [hook],
      retry: retryOnce,
      sleepFn,
    });
    let calls = 0;
    await dispatcher.run(baseCtx, async () => {
      calls += 1;
      if (calls === 1) throw new RateLimitError("slow", 10);
      return okResult;
    });
    expect(observedSuccessAttempt).toBe(2);
  });

  it("does not leak prior attempt's error into onCallSuccess after a retry recovery", async () => {
    const seenAtSuccess: Array<{ hasError: boolean; hasResponse: boolean; attempt: number }> = [];
    const seenAtEnd: Array<{ hasError: boolean; hasResponse: boolean; attempt: number }> = [];
    const hook: Hook = {
      name: "spy",
      onCallSuccess(ctx) {
        seenAtSuccess.push({
          hasError: ctx.error !== undefined,
          hasResponse: ctx.response !== undefined,
          attempt: ctx.attempt,
        });
      },
      onCallEnd(ctx) {
        seenAtEnd.push({
          hasError: ctx.error !== undefined,
          hasResponse: ctx.response !== undefined,
          attempt: ctx.attempt,
        });
      },
    };
    const { sleepFn } = recordingSleep();
    const dispatcher = new HookDispatcher({
      hooks: [hook],
      retry: retryOnce,
      sleepFn,
    });
    let calls = 0;
    const result = await dispatcher.run(baseCtx, async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError("transient", "anthropic");
      return okResult;
    });
    expect(result.content).toBe("hello");
    expect(seenAtSuccess).toEqual([{ hasError: false, hasResponse: true, attempt: 2 }]);
    expect(seenAtEnd).toEqual([{ hasError: false, hasResponse: true, attempt: 2 }]);
  });

  it("wraps unknown throws as non-retryable ProviderError", async () => {
    const { sleepFn } = recordingSleep();
    const dispatcher = new HookDispatcher({
      retry: new ExponentialBackoffStrategy({ config: testConfig().retry }),
      sleepFn,
    });
    let calls = 0;
    await expect(
      dispatcher.run(baseCtx, async () => {
        calls += 1;
        throw new Error("oops");
      }),
    ).rejects.toThrow("oops");
    // Unknown throws are wrapped non-retryable, so the strategy gives up after
    // attempt 1 instead of burning the full budget on a deterministic failure.
    expect(calls).toBe(1);
  });

  it("uses real setTimeout-backed sleep when no sleepFn is supplied (smoke; tiny delay)", async () => {
    const tinyDelayStrategy: RetryStrategy = {
      decide: (attempt) => (attempt === 1 ? 1 : null),
    };
    const dispatcher = new HookDispatcher({ retry: tinyDelayStrategy });
    let calls = 0;
    // We want to prove `defaultSleep` is not a no-op. Date.now() rounds to
    // whole ms which made a `>= 1` assertion intermittently fail on fast
    // runners; hrtime.bigint() reads nanoseconds. Empirically a setTimeout(1)
    // can return slightly before 1ms on some Node 22 runners (~750us), so we
    // assert >= 100_000ns (100us): comfortably above the few-us awaiting a
    // synchronously-resolved Promise would take, and well below any real
    // setTimeout firing.
    const start = process.hrtime.bigint();
    const result = await dispatcher.run(baseCtx, async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError("transient", "anthropic");
      return okResult;
    });
    const elapsedNs = process.hrtime.bigint() - start;
    expect(calls).toBe(2);
    expect(result).toEqual(okResult);
    expect(elapsedNs).toBeGreaterThanOrEqual(100_000n);
  });
});
