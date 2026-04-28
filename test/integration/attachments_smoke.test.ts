/**
 * Layer 1 smoke for image attachments. Drives `ai.ask` end-to-end against an
 * injected `MockProvider` and asserts the captured `ProviderRequest` carries
 * the attachments array unchanged. The mock never translates attachments to
 * any vendor shape; the per-adapter translation is exercised in the Anthropic
 * unit tests at `test/providers/anthropic_provider.test.ts`.
 *
 * This is the canonical RED -> GREEN target for batch 1.5: the test is written
 * before the `Attachment` type exists, before `attachments` lands on
 * `AskOptions`, before `ProviderRequest` carries it, and before the wiring in
 * `ai.ask` spreads it into the request.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.ask attachments smoke (MockProvider)", () => {
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

  it("passes a base64 image attachment through to the provider request", async () => {
    mock.pushResponse({
      content: "I see a tiny PNG.",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    // 1x1 transparent PNG. Buffer ownership is the user's; we reference it
    // by identity in the assertion below to guarantee no copy happened.
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );

    const result = await ai.ask("describe this", {
      attachments: [
        {
          kind: "image",
          source: { type: "base64", data: pngBuffer, mimeType: "image/png" },
        },
      ],
    });

    expect(result).toBe("I see a tiny PNG.");
    expect(mock.requests).toHaveLength(1);
    const captured = mock.requests[0];
    if (captured === undefined) throw new Error("expected one captured request");

    expect(captured.attachments).toBeDefined();
    expect(captured.attachments).toHaveLength(1);
    const att = captured.attachments?.[0];
    expect(att).toEqual({
      kind: "image",
      source: { type: "base64", data: pngBuffer, mimeType: "image/png" },
    });
    // Identity check: the adapter receives the same Buffer the user supplied.
    if (att?.kind !== "image" || att.source.type !== "base64") {
      throw new Error("expected base64 image attachment");
    }
    expect(att.source.data).toBe(pngBuffer);
  });

  it("passes a URL image attachment through to the provider request", async () => {
    mock.pushResponse({
      content: "I see a remote image.",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.ask("describe this", {
      attachments: [
        {
          kind: "image",
          source: { type: "url", url: "https://example.com/cat.jpg" },
        },
      ],
    });

    const captured = mock.requests[0];
    if (captured === undefined) throw new Error("expected one captured request");
    expect(captured.attachments).toEqual([
      { kind: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
    ]);
  });

  it("omits attachments from the provider request when not supplied", async () => {
    mock.pushResponse({
      content: "no image",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.ask("hi");

    const captured = mock.requests[0];
    if (captured === undefined) throw new Error("expected one captured request");
    expect(captured.attachments).toBeUndefined();
  });
});
