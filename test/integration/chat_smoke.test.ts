/**
 * Layer 1 smoke for `ai.chat`. Drives the end-to-end public surface against
 * an injected `MockProvider` and asserts the captured `ProviderRequest`
 * carries the message array (with system messages routed to `req.system`)
 * and the mock-returned content surfaces as the return value.
 *
 * RED -> GREEN target for batch 1.7's chat arm.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.chat smoke (MockProvider)", () => {
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

  it("returns the mock content for a single user message", async () => {
    mock.pushResponse({
      content: "hi back",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await ai.chat([{ role: "user", content: "hi" }]);

    expect(result).toBe("hi back");
    expect(mock.requests).toHaveLength(1);
    const captured = mock.requests[0];
    expect(captured?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(captured?.system).toBeUndefined();
  });

  it("routes a role:'system' message in the array to req.system", async () => {
    mock.pushResponse({
      content: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.chat([
      { role: "system", content: "be terse" },
      { role: "user", content: "explain RLHF" },
    ]);

    const captured = mock.requests[0];
    expect(captured?.system).toBe("be terse");
    expect(captured?.messages).toEqual([{ role: "user", content: "explain RLHF" }]);
  });

  it("prefers the in-array system message over options.system", async () => {
    mock.pushResponse({
      content: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.chat(
      [
        { role: "system", content: "from-array" },
        { role: "user", content: "hi" },
      ],
      { system: "from-options" },
    );

    const captured = mock.requests[0];
    expect(captured?.system).toBe("from-array");
  });

  it("uses options.system when no in-array system message is present", async () => {
    mock.pushResponse({
      content: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.chat([{ role: "user", content: "hi" }], { system: "from-options" });

    const captured = mock.requests[0];
    expect(captured?.system).toBe("from-options");
    expect(captured?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("forwards a multi-turn conversation verbatim when no system is present", async () => {
    mock.pushResponse({
      content: "third reply",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
      { role: "user" as const, content: "how are you" },
    ];

    await ai.chat(messages);

    const captured = mock.requests[0];
    expect(captured?.messages).toEqual(messages);
    expect(captured?.system).toBeUndefined();
  });
});
