/**
 * Unit tests for the test-only `MockProvider`. Exercises FIFO behavior on
 * both queues, request capture, the empty-queue error contract, and the
 * "stream not yet implemented" placeholder.
 */

import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/errors/index.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import type { ProviderRequest, ProviderResponse } from "../../src/providers/provider.js";

const sampleRequest: ProviderRequest = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
};

function res(content: string): ProviderResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "end",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

describe("MockProvider", () => {
  it("request() throws ProviderError when no responses are queued", async () => {
    const mock = new MockProvider();
    await expect(mock.request(sampleRequest)).rejects.toBeInstanceOf(ProviderError);
  });

  it("request() consumes responses FIFO", async () => {
    const mock = new MockProvider();
    mock.pushResponse(res("first"));
    mock.pushResponse(res("second"));
    const a = await mock.request(sampleRequest);
    const b = await mock.request(sampleRequest);
    expect(a.content).toBe("first");
    expect(b.content).toBe("second");
  });

  it("errors win over responses when both queued, and consume FIFO", async () => {
    const mock = new MockProvider();
    mock.pushResponse(res("never seen"));
    mock.pushError(new Error("fail-1"));
    mock.pushError(new Error("fail-2"));
    await expect(mock.request(sampleRequest)).rejects.toThrow("fail-1");
    await expect(mock.request(sampleRequest)).rejects.toThrow("fail-2");
    // After both errors are consumed, the queued response surfaces.
    const r = await mock.request(sampleRequest);
    expect(r.content).toBe("never seen");
  });

  it("captures every incoming request in arrival order", async () => {
    const mock = new MockProvider();
    mock.pushResponse(res("a"));
    mock.pushResponse(res("b"));
    await mock.request({ ...sampleRequest, messages: [{ role: "user", content: "first" }] });
    await mock.request({ ...sampleRequest, messages: [{ role: "user", content: "second" }] });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]?.messages[0]?.content).toBe("first");
    expect(mock.requests[1]?.messages[0]?.content).toBe("second");
  });

  it("reset() clears responses, errors, and requests", async () => {
    const mock = new MockProvider();
    mock.pushResponse(res("a"));
    mock.pushError(new Error("e"));
    await mock.request(sampleRequest).catch(() => undefined);
    expect(mock.requests).toHaveLength(1);
    mock.reset();
    expect(mock.responses).toHaveLength(0);
    expect(mock.errors).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
  });

  it("requestStream() yields scripted chunks and resolves usage", async () => {
    const mock = new MockProvider();
    mock.pushStreamChunks(["a", "b", "c"], { inputTokens: 1, outputTokens: 3 });

    const { stream, usage } = mock.requestStream(sampleRequest);
    const collected: string[] = [];
    for await (const chunk of stream) {
      collected.push(chunk);
    }
    expect(collected).toEqual(["a", "b", "c"]);
    await expect(usage).resolves.toEqual({ inputTokens: 1, outputTokens: 3 });
    expect(mock.streamRequests).toHaveLength(1);
  });

  it("requestStream() with no script throws a clear ProviderError", async () => {
    const mock = new MockProvider();
    const { stream, usage } = mock.requestStream(sampleRequest);
    // Suppress unhandled rejection on the usage promise; the iterator's
    // first next() carries the same error to the caller.
    usage.catch(() => {
      // intentional swallow: the iterator carries the error
    });
    await expect(async () => {
      for await (const _ of stream) {
        // unreachable
      }
    }).rejects.toThrow(/no queued stream script/);
  });

  it("constructs as the openai provider when requested", () => {
    const mock = new MockProvider("openai");
    expect(mock.name).toBe("openai");
  });

  it("public arrays cannot be mutated externally (TS type guard)", () => {
    const mock = new MockProvider();
    // The next three statements must each be a TS error: the public surface
    // is readonly so consumers cannot bypass pushResponse / pushError / reset.
    // If TS does not flag a line, the @ts-expect-error directive itself
    // becomes a compile error and breaks the typecheck gate, which is
    // exactly the signal we want.
    // @ts-expect-error - responses is readonly to external callers
    mock.responses.push(res("nope"));
    // @ts-expect-error - errors is readonly to external callers
    mock.errors.push(new Error("nope"));
    // @ts-expect-error - requests is readonly to external callers
    mock.requests.push(sampleRequest);

    // Runtime sanity: the public API still exposes read access. We expect
    // the @ts-expect-error suppressions above to allow the calls at runtime
    // (TS only erases types), so the arrays now contain the pushed items.
    // The contract this test locks is the COMPILE-TIME readonly-ness, not
    // runtime immutability (which would require Object.freeze and a real
    // perf hit on every push).
    expect(mock.responses.length).toBeGreaterThanOrEqual(0);
  });
});
