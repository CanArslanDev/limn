/**
 * Layer 1 smoke test. Drives `ai.ask` end-to-end against an injected
 * `MockProvider` so the public surface is exercised without a network call.
 *
 * The mock is registered as the "anthropic" provider for the duration of the
 * test and reset afterwards so the registry does not leak into other test
 * files. This is the canonical RED -> GREEN target for batch 1.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.ask smoke (MockProvider)", () => {
  let mock: MockProvider;
  let previous: ReturnType<typeof getProvider> | undefined;

  beforeEach(() => {
    // Defense against test-pollution: if another test file's afterEach
    // failed to reset the dispatcher factory, this smoke would observe a
    // recording dispatcher instead of the production default. Explicit
    // reset here keeps the smoke an independent oracle.
    __setDispatcherFactoryForTests(undefined);
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
      // No prior registration. Explicitly unregister so the mock does not
      // leak into the next test file in this Vitest worker.
      unregisterProvider("anthropic");
    }
  });

  it("returns the queued mock response content", async () => {
    mock.pushResponse({
      content: "hello",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await ai.ask("hi");

    expect(result).toBe("hello");
    expect(mock.requests).toHaveLength(1);
    const captured = mock.requests[0];
    expect(captured).toBeDefined();
    expect(captured?.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("dispatches against the model resolved from defaults when none given", async () => {
    mock.pushResponse({
      content: "world",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.ask("hi");

    const captured = mock.requests[0];
    // Default model is the Sonnet variant; routes to the anthropic provider.
    expect(captured?.model).toBe("claude-sonnet-4-6");
  });
});
