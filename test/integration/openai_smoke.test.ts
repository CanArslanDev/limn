/**
 * Layer 1 smoke test for OpenAI routing. Drives `ai.ask("hi", { model:
 * "gpt-4o-mini" })` end-to-end against an injected `MockProvider`
 * registered as the OpenAI provider, so the public surface is exercised
 * without a network call.
 *
 * Asserts that:
 * - `providerFor` routes the OpenAI model name to the OpenAI provider slot.
 * - The dispatched ProviderRequest carries the OpenAI model name through.
 * - The mock-returned content surfaces as the `ai.ask` return value.
 *
 * The mock is registered as the "openai" provider for the duration of the
 * test and reset afterwards so the registry does not leak into other test
 * files.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.ask smoke (MockProvider as openai)", () => {
  let mock: MockProvider;
  let previous: ReturnType<typeof getProvider> | undefined;

  beforeEach(() => {
    __setDispatcherFactoryForTests(() => new HookDispatcher());
    try {
      previous = getProvider("openai");
    } catch {
      previous = undefined;
    }
    mock = new MockProvider("openai");
    registerProvider("openai", mock);
  });

  afterEach(() => {
    mock.reset();
    if (previous !== undefined) {
      registerProvider("openai", previous);
    } else {
      unregisterProvider("openai");
    }
    __setDispatcherFactoryForTests(undefined);
  });

  it("routes ai.ask with gpt-4o-mini through the openai provider slot", async () => {
    mock.pushResponse({
      content: "hello from openai mock",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await ai.ask("hi", { model: "gpt-4o-mini" });

    expect(result).toBe("hello from openai mock");
    expect(mock.requests).toHaveLength(1);
    const captured = mock.requests[0];
    expect(captured?.model).toBe("gpt-4o-mini");
    expect(captured?.messages[0]).toEqual({ role: "user", content: "hi" });
  });
});
