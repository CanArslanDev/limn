/**
 * Integration smoke for the retry pipeline. Drives `ai.ask` end-to-end
 * against a `MockProvider` scripted to throw a `RateLimitError(500)` then
 * succeed; asserts the strategy honored the supplied `retryAfterMs`, the
 * dispatcher invoked the provider twice, and the final response surfaced.
 *
 * The dispatcher's `sleepFn` is replaced via `__setDispatcherFactoryForTests`
 * so the test runs synchronously (no real 500ms wall delay) while still
 * exercising the production strategy + dispatcher loop.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { DEFAULT_CONFIG } from "../../src/config/traceworks_config.js";
import { RateLimitError } from "../../src/errors/index.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { ExponentialBackoffStrategy } from "../../src/hooks/retry_strategy.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.ask retry integration (MockProvider)", () => {
  let mock: MockProvider;
  let previous: ReturnType<typeof getProvider> | undefined;
  let recordedDelays: number[];

  beforeEach(() => {
    try {
      previous = getProvider("anthropic");
    } catch {
      previous = undefined;
    }
    mock = new MockProvider("anthropic");
    registerProvider("anthropic", mock);

    recordedDelays = [];
    __setDispatcherFactoryForTests(
      () =>
        new HookDispatcher({
          retry: new ExponentialBackoffStrategy({ config: DEFAULT_CONFIG.retry }),
          sleepFn: async (ms) => {
            recordedDelays.push(ms);
          },
        }),
    );
  });

  afterEach(() => {
    mock.reset();
    if (previous !== undefined) {
      registerProvider("anthropic", previous);
    } else {
      unregisterProvider("anthropic");
    }
    __setDispatcherFactoryForTests(undefined);
  });

  it("retries after RateLimitError(500ms) and returns the second response", async () => {
    mock.pushError(new RateLimitError("slow down", 500));
    mock.pushResponse({
      content: "ok-after-retry",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await ai.ask("hi");

    expect(result).toBe("ok-after-retry");
    expect(mock.requests).toHaveLength(2);
    // Strategy honored the supplied retryAfterMs verbatim.
    expect(recordedDelays).toEqual([500]);
  });

  it("retries up to maxAttempts then surfaces the final RateLimitError", async () => {
    // DEFAULT_CONFIG.retry.maxAttempts === 3 so we expect 3 attempts and the
    // strategy to give up on attempt 3 (delays recorded between 1->2 and 2->3).
    mock.pushError(new RateLimitError("slow", 100));
    mock.pushError(new RateLimitError("slow", 200));
    mock.pushError(new RateLimitError("slow", 300));

    await expect(ai.ask("hi")).rejects.toBeInstanceOf(RateLimitError);
    expect(mock.requests).toHaveLength(3);
    expect(recordedDelays).toEqual([100, 200]);
  });
});
