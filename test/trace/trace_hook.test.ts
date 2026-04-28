/**
 * Unit tests for `TraceHook`. The hook captures start/end timestamps,
 * builds a {@link TraceRecord} from the shared {@link TraceState}, and
 * hands it to the configured sink at `onCallEnd`. Coordinates with
 * `RedactionHook` via the same shared state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/errors/index.js";
import type { HookContext } from "../../src/hooks/dispatcher.js";
import { TraceHook } from "../../src/hooks/trace_hook.js";
import type { TraceState } from "../../src/hooks/trace_state.js";
import type { TraceRecord, TraceSink } from "../../src/trace/trace.js";

class RecordingSink implements TraceSink {
  public readonly written: TraceRecord[] = [];
  public throwOnWrite = false;
  public async write(record: TraceRecord): Promise<void> {
    if (this.throwOnWrite) throw new Error("disk full");
    this.written.push(record);
  }
  public async list(): Promise<readonly TraceRecord[]> {
    return this.written;
  }
  public async read(_id: string): Promise<TraceRecord | null> {
    return null;
  }
}

function newState(overrides: Partial<TraceState> = {}): TraceState {
  return { id: "trc_test", redactedFields: [], ...overrides };
}

function newCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    traceId: "trc_test",
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    attempt: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TraceHook", () => {
  it("writes one record per call carrying timestamp, latency, model, provider", async () => {
    const sink = new RecordingSink();
    const state = newState();
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [] },
    });

    await hook.onCallStart(newCtx());
    await hook.onCallSuccess(
      newCtx({
        response: { content: "hello", inputTokens: 1, outputTokens: 2 },
      }),
    );
    await hook.onCallEnd(
      newCtx({
        response: { content: "hello", inputTokens: 1, outputTokens: 2 },
      }),
    );

    expect(sink.written).toHaveLength(1);
    const rec = sink.written[0];
    expect(rec).toBeDefined();
    expect(rec?.id).toBe("trc_test");
    expect(rec?.kind).toBe("ask");
    expect(rec?.provider).toBe("anthropic");
    expect(rec?.model).toBe("claude-sonnet-4-6");
    expect(rec?.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(rec?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(rec?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec?.error).toBeUndefined();
  });

  it("captures the response content into the persisted record", async () => {
    const sink = new RecordingSink();
    const state = newState();
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [{ role: "user", content: "hi" }] },
    });

    await hook.onCallStart(newCtx());
    const successCtx = newCtx({
      response: { content: "ok", inputTokens: 1, outputTokens: 1 },
    });
    await hook.onCallSuccess(successCtx);
    await hook.onCallEnd(successCtx);

    expect(sink.written[0]?.response).toEqual({
      content: "ok",
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it("records error code + message when the call failed", async () => {
    const sink = new RecordingSink();
    const state = newState();
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [] },
    });

    await hook.onCallStart(newCtx());
    const err = new ProviderError("boom", "anthropic");
    await hook.onCallError(newCtx({ error: err }));
    await hook.onCallEnd(newCtx({ error: err }));

    expect(sink.written).toHaveLength(1);
    expect(sink.written[0]?.error).toEqual({
      code: "PROVIDER_ERROR",
      message: "boom",
    });
    expect(sink.written[0]?.response).toBeUndefined();
  });

  it("reflects the final attempt count from the context", async () => {
    const sink = new RecordingSink();
    const state = newState();
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [] },
    });

    await hook.onCallStart(newCtx());
    const successCtx = newCtx({
      attempt: 3,
      response: { content: "ok", inputTokens: 1, outputTokens: 1 },
    });
    await hook.onCallSuccess(successCtx);
    await hook.onCallEnd(successCtx);

    expect(sink.written[0]?.attempts).toBe(3);
  });

  it("copies redactedFields verbatim from the shared state", async () => {
    const sink = new RecordingSink();
    const state = newState({
      redactedFields: ["request.messages.0.content", "response.content"],
    });
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [] },
    });

    await hook.onCallStart(newCtx());
    const successCtx = newCtx({
      response: { content: "ok", inputTokens: 1, outputTokens: 1 },
    });
    await hook.onCallSuccess(successCtx);
    await hook.onCallEnd(successCtx);

    expect(sink.written[0]?.redactedFields).toEqual([
      "request.messages.0.content",
      "response.content",
    ]);
  });

  it("falls back to the constructor request when state.request is unset (redaction disabled)", async () => {
    const sink = new RecordingSink();
    const state = newState();
    const baseRequest = { messages: [{ role: "user", content: "hello" }] };
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: baseRequest,
    });

    await hook.onCallStart(newCtx());
    const successCtx = newCtx({
      response: { content: "ok", inputTokens: 1, outputTokens: 1 },
    });
    await hook.onCallSuccess(successCtx);
    await hook.onCallEnd(successCtx);

    expect(sink.written[0]?.request).toEqual(baseRequest);
  });

  it("prefers state.request over the constructor request when redaction populated it", async () => {
    const sink = new RecordingSink();
    const state = newState({
      request: { messages: [{ role: "user", content: "[REDACTED]" }] },
    });
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [{ role: "user", content: "raw secret" }] },
    });

    await hook.onCallStart(newCtx());
    const successCtx = newCtx({
      response: { content: "ok", inputTokens: 1, outputTokens: 1 },
    });
    await hook.onCallSuccess(successCtx);
    await hook.onCallEnd(successCtx);

    expect(sink.written[0]?.request).toEqual({
      messages: [{ role: "user", content: "[REDACTED]" }],
    });
  });

  it("survives a sink write failure with a console.warn rather than crashing the call", async () => {
    const sink = new RecordingSink();
    sink.throwOnWrite = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const state = newState();
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [] },
    });

    await hook.onCallStart(newCtx());
    const successCtx = newCtx({
      response: { content: "ok", inputTokens: 1, outputTokens: 1 },
    });
    await hook.onCallSuccess(successCtx);

    await expect(hook.onCallEnd(successCtx)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // The warning includes the trace ID so users can correlate the warning
    // to a specific call when scanning logs.
    const firstArg = warn.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe("string");
    expect(firstArg as string).toContain("trc_test");
    expect(firstArg as string).toContain("RecordingSink");
  });

  it("produces a positive latency when the call took measurable time", async () => {
    const sink = new RecordingSink();
    const state = newState();
    const hook = new TraceHook({
      state,
      sink,
      kind: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      request: { messages: [] },
    });

    // Pin the clock so the "elapsed" computation is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    await hook.onCallStart(newCtx());

    vi.setSystemTime(1_700_000_000_250);
    const successCtx = newCtx({
      response: { content: "ok", inputTokens: 1, outputTokens: 1 },
    });
    await hook.onCallSuccess(successCtx);
    await hook.onCallEnd(successCtx);

    vi.useRealTimers();
    expect(sink.written[0]?.latencyMs).toBe(250);
  });
});
