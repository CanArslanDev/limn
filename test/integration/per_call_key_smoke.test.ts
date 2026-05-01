/**
 * Per-call API key override smoke. The dispatcher's normal path goes
 * through the registry's cached provider (in tests, a MockProvider). The
 * `apiKey` per-call option short-circuits that and constructs a fresh
 * adapter for ONE call. This test asserts both halves: the no-override
 * path uses the registered mock; the override path bypasses it.
 *
 * The override path attempts to reach the real Anthropic API (no fake
 * fetch is injected because the per-call adapter is constructed fresh
 * inside `resolveProvider`, beneath the user's reach). To keep the test
 * hermetic, we point the override at a syntactically-valid but
 * non-functional key and assert the call throws SOMETHING (proving we
 * left the mock and entered the real adapter). We do NOT assert the
 * specific error class because the failure mode depends on whether the
 * @anthropic-ai/sdk peer dep is present and how it surfaces network
 * errors; the integration's job is to prove the adapter swap, not to
 * pin the network error shape.
 *
 * RED -> GREEN target for batch 1.8.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.ask per-call apiKey override", () => {
  let mock: MockProvider;
  let previous: ReturnType<typeof getProvider> | undefined;

  beforeEach(() => {
    // Hook-less, retry-less dispatcher: the smoke is about which provider
    // the client picks, not the production hook stack. Trace + retry
    // behavior is covered by their dedicated smokes.
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

  it("uses the registered MockProvider when no apiKey override is supplied", async () => {
    mock.pushResponse({
      content: "from-mock",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await ai.ask("hi");

    expect(result).toBe("from-mock");
    expect(mock.requests).toHaveLength(1);
  });

  it("bypasses the registered MockProvider when apiKey is supplied per call", async () => {
    // No response queued on the mock: if the dispatcher hits the mock
    // anyway, the test fails noisily because the mock surfaces an
    // "underflow" error. The point is to prove we left the mock.
    let threw = false;
    try {
      await ai.ask("hi", { apiKey: "sk-ant-FAKE-PER-CALL-KEY-FOR-TEST-ONLY" });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // The mock never saw the request: a fresh AnthropicProvider was
    // constructed for this one call instead.
    expect(mock.requests).toHaveLength(0);
  });
});
