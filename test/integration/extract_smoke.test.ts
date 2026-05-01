/**
 * Layer 1 smoke for `ai.extract`. Drives the public surface against an
 * injected `MockProvider` returning canned JSON; asserts the parsed result
 * matches the Zod schema, that schema-mismatch responses throw
 * `SchemaValidationError` with the documented context, and that
 * `retryOnSchemaFailure: true` retries once with the validation message
 * fed back to the model.
 *
 * RED -> GREEN target for batch 1.7's extract arm.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { __setDispatcherFactoryForTests, ai } from "../../src/client/ai.js";
import { SchemaValidationError } from "../../src/errors/index.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.extract smoke (MockProvider)", () => {
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

  it("returns the parsed object when the model emits valid JSON", async () => {
    mock.pushResponse({
      content: '{"name":"Ada","age":36}',
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const Person = z.object({ name: z.string(), age: z.number() });
    const result = await ai.extract(Person, "extract person from: ...");

    expect(result).toEqual({ name: "Ada", age: 36 });
    expect(mock.requests).toHaveLength(1);
    // The system prompt names the JSON schema; the user message carries the
    // input verbatim. Both ride through the standard provider request shape.
    const captured = mock.requests[0];
    expect(captured?.system).toBeDefined();
    expect(captured?.system).toContain("JSON");
    expect(captured?.messages).toEqual([{ role: "user", content: "extract person from: ..." }]);
  });

  it("throws SchemaValidationError when the model emits invalid JSON", async () => {
    mock.pushResponse({
      content: "this is not json",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const Person = z.object({ name: z.string(), age: z.number() });

    await expect(ai.extract(Person, "extract person from: ...")).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });

  it("throws SchemaValidationError carrying expectedSchemaName + actualPayload", async () => {
    mock.pushResponse({
      content: '{"name":"Ada"}',
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const Person = z.object({ name: z.string(), age: z.number() });

    try {
      await ai.extract(Person, "input");
      throw new Error("expected ai.extract to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const sve = err as SchemaValidationError;
      expect(sve.expectedSchemaName).toBeDefined();
      expect(sve.actualPayload).toEqual({ name: "Ada" });
    }
  });

  it("retries once with retryOnSchemaFailure:true when the first response is invalid", async () => {
    mock.pushResponse({
      content: "not json",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    mock.pushResponse({
      content: '{"name":"Bob","age":42}',
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const Person = z.object({ name: z.string(), age: z.number() });
    const result = await ai.extract(Person, "input", { retryOnSchemaFailure: true });

    expect(result).toEqual({ name: "Bob", age: 42 });
    expect(mock.requests).toHaveLength(2);
    // The second request includes corrective feedback referencing the prior
    // failure; the message array grows by at least one assistant + user pair.
    const second = mock.requests[1];
    expect(second).toBeDefined();
    expect(second?.messages.length ?? 0).toBeGreaterThan(1);
  });

  it("throws SchemaValidationError when both attempts fail with retryOnSchemaFailure:true", async () => {
    mock.pushResponse({
      content: "still not json",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    mock.pushResponse({
      content: "still still not json",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const Person = z.object({ name: z.string(), age: z.number() });

    await expect(
      ai.extract(Person, "input", { retryOnSchemaFailure: true }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    expect(mock.requests).toHaveLength(2);
  });
});
