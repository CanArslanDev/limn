/**
 * Layer 1 smoke for `ai.stream`. Drives the public surface against an
 * injected `MockProvider` scripted with chunk sequences and asserts:
 *
 *   - The async iterator yields the scripted chunks in order.
 *   - The `onChunk` callback fires once per chunk before the iterator yields.
 *   - First-chunk failure followed by success retries (the consumer sees only
 *     the second stream's chunks).
 *   - Mid-stream failure surfaces to the consumer after the chunks already
 *     emitted reach them; no retry happens because chunks were yielded.
 *
 * RED -> GREEN target for batch 1.7's stream arm.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { DEFAULT_CONFIG } from "../../src/config/traceworks_config.js";
import { ProviderError, RateLimitError } from "../../src/errors/index.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { ExponentialBackoffStrategy } from "../../src/hooks/retry_strategy.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.stream smoke (MockProvider)", () => {
  let mock: MockProvider;
  let previous: ReturnType<typeof getProvider> | undefined;

  beforeEach(() => {
    __setDispatcherFactoryForTests(() => new HookDispatcher());
    try {
      previous = getProvider("anthropic");
    } catch {
      previous = undefined;
    }
    mock = new MockProvider("anthropic");
    registerProvider("anthropic", mock);
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

  it("yields scripted chunks in order via the async iterator", async () => {
    mock.pushStreamChunks(["Hel", "lo, ", "world!"], { inputTokens: 1, outputTokens: 3 });

    const collected: string[] = [];
    for await (const chunk of ai.stream("hi")) {
      collected.push(chunk);
    }

    expect(collected).toEqual(["Hel", "lo, ", "world!"]);
    expect(mock.streamRequests).toHaveLength(1);
    const captured = mock.streamRequests[0];
    expect(captured?.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("fires the onChunk callback once per chunk", async () => {
    mock.pushStreamChunks(["a", "b", "c"], { inputTokens: 1, outputTokens: 3 });

    const seen: string[] = [];
    for await (const _ of ai.stream("hi", { onChunk: (c) => seen.push(c) })) {
      // intentional: onChunk drives the assertion; the iterator drives the loop.
    }

    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("retries the stream when the first attempt fails before any chunk emits", async () => {
    // Use a dispatcher with the production retry strategy + a recording sleep
    // so the test runs synchronously while still exercising the retry loop.
    const recordedDelays: number[] = [];
    __setDispatcherFactoryForTests(
      () =>
        new HookDispatcher({
          retry: new ExponentialBackoffStrategy({ config: DEFAULT_CONFIG.retry }),
          sleepFn: async (ms) => {
            recordedDelays.push(ms);
          },
        }),
    );

    mock.pushStreamError(new RateLimitError("slow", 250));
    mock.pushStreamChunks(["ok-after-retry"], { inputTokens: 1, outputTokens: 1 });

    const collected: string[] = [];
    for await (const chunk of ai.stream("hi")) {
      collected.push(chunk);
    }

    expect(collected).toEqual(["ok-after-retry"]);
    expect(mock.streamRequests).toHaveLength(2);
    expect(recordedDelays).toEqual([250]);
  });

  it("surfaces a mid-stream error after the chunks already emitted", async () => {
    mock.pushStreamChunks(
      ["partial-1", "partial-2"],
      { inputTokens: 1, outputTokens: 2 },
      new ProviderError("midstream boom", "anthropic", undefined, false),
    );

    const collected: string[] = [];
    let caught: unknown;
    try {
      for await (const chunk of ai.stream("hi")) {
        collected.push(chunk);
      }
    } catch (err) {
      caught = err;
    }

    expect(collected).toEqual(["partial-1", "partial-2"]);
    expect(caught).toBeInstanceOf(ProviderError);
    // Mid-stream failure does NOT retry: re-issuing would duplicate output.
    expect(mock.streamRequests).toHaveLength(1);
  });
});
