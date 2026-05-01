/**
 * Unit tests for `RedactionHook`. The hook walks the per-call request,
 * response, and error message through `redactKeys` and accumulates the
 * dot-paths of every field that was scrubbed onto the shared
 * {@link TraceState}. Coordinates with `TraceHook` via that shared state.
 */

import { describe, expect, it } from "vitest";
import { ProviderError, RateLimitError } from "../../src/errors/index.js";
import type { HookContext } from "../../src/hooks/dispatcher.js";
import { RedactionHook } from "../../src/hooks/redaction_hook.js";
import type { TraceState } from "../../src/hooks/trace_state.js";

const ANT_KEY = "sk-ant-AAABBBCCCDDDDEEEFFFGGGHHH";

function newState(): TraceState {
  return { id: "trc_test", redactedFields: [] };
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

describe("RedactionHook", () => {
  it("scrubs the request on onCallStart and records the dot-paths", async () => {
    const state = newState();
    const request = { messages: [{ role: "user", content: `Use ${ANT_KEY}` }] };
    const hook = new RedactionHook({ state, request });

    await hook.onCallStart(newCtx());

    expect(state.request).toEqual({
      messages: [{ role: "user", content: "Use [REDACTED]" }],
    });
    expect(state.redactedFields).toEqual(["request.messages.0.content"]);
  });

  it("leaves a clean request untouched and records no fields", async () => {
    const state = newState();
    const request = { messages: [{ role: "user", content: "hello" }] };
    const hook = new RedactionHook({ state, request });

    await hook.onCallStart(newCtx());

    expect(state.request).toEqual(request);
    expect(state.redactedFields).toEqual([]);
  });

  it("captures the response on onCallSuccess and redacts any keys inside", async () => {
    const state = newState();
    const hook = new RedactionHook({ state, request: { messages: [] } });
    await hook.onCallStart(newCtx());

    await hook.onCallSuccess(
      newCtx({
        response: { content: `Token: ${ANT_KEY}`, inputTokens: 1, outputTokens: 5 },
      }),
    );

    expect(state.response).toEqual({
      content: "Token: [REDACTED]",
      inputTokens: 1,
      outputTokens: 5,
    });
    expect(state.redactedFields).toContain("response.content");
  });

  it("records error code + redacted message on onCallError", async () => {
    const state = newState();
    const hook = new RedactionHook({ state, request: { messages: [] } });
    await hook.onCallStart(newCtx());

    const err = new ProviderError(`upstream said ${ANT_KEY}`, "anthropic");
    await hook.onCallError(newCtx({ error: err }));

    expect(state.error).toEqual({
      code: "PROVIDER_ERROR",
      message: "upstream said [REDACTED]",
    });
    expect(state.redactedFields).toContain("error.message");
  });

  it("preserves error codes for every TraceworksError subclass it sees", async () => {
    const state = newState();
    const hook = new RedactionHook({ state, request: { messages: [] } });
    await hook.onCallStart(newCtx());

    const err = new RateLimitError("slow", 200);
    await hook.onCallError(newCtx({ error: err }));

    expect(state.error?.code).toBe("RATE_LIMIT");
  });

  it("does not duplicate redactedFields entries across phases", async () => {
    // The persisted dot-paths should be unique per phase. A field redacted
    // both in the request and in the response carries two distinct entries
    // (different prefixes); a field redacted twice in the same phase only
    // appears once.
    const state = newState();
    const request = { secret: ANT_KEY };
    const hook = new RedactionHook({ state, request });

    await hook.onCallStart(newCtx());
    expect(state.redactedFields).toEqual(["request.secret"]);

    await hook.onCallSuccess(
      newCtx({
        response: { content: ANT_KEY, inputTokens: 1, outputTokens: 1 },
      }),
    );

    expect(state.redactedFields).toEqual(["request.secret", "response.content"]);
  });
});
