/**
 * Unit tests for the `HookDispatcher`. Covers the five lifecycle phases, the
 * "hook errors do not crash the call" contract, and the read-only context
 * shape passed to each phase.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/errors/index.js";
import { type Hook, HookDispatcher } from "../../src/hooks/dispatcher.js";

const baseCtx = {
  traceId: "trc_test",
  model: "claude-sonnet-4-6" as const,
  messages: [{ role: "user" as const, content: "hi" }],
};

const okResult = { content: "hello", inputTokens: 1, outputTokens: 1 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HookDispatcher", () => {
  it("runs exec and returns its result when no hooks are registered", async () => {
    const dispatcher = new HookDispatcher();
    const out = await dispatcher.run(baseCtx, async () => okResult);
    expect(out).toEqual(okResult);
  });

  it("fires onCallStart -> exec -> onCallSuccess -> onCallEnd in order on success", async () => {
    const order: string[] = [];
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        order.push("start");
      },
      onCallSuccess: () => {
        order.push("success");
      },
      onCallError: () => {
        order.push("error");
      },
      onCallEnd: () => {
        order.push("end");
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await dispatcher.run(baseCtx, async () => {
      order.push("exec");
      return okResult;
    });
    expect(order).toEqual(["start", "exec", "success", "end"]);
  });

  it("fires onCallStart -> exec -> onCallError -> onCallEnd on failure and rethrows", async () => {
    const order: string[] = [];
    const hook: Hook = {
      name: "spy",
      onCallStart: () => {
        order.push("start");
      },
      onCallSuccess: () => {
        order.push("success");
      },
      onCallError: () => {
        order.push("error");
      },
      onCallEnd: () => {
        order.push("end");
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    const boom = new ProviderError("boom", "anthropic");
    await expect(
      dispatcher.run(baseCtx, async () => {
        order.push("exec");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(order).toEqual(["start", "exec", "error", "end"]);
  });

  it("a throwing hook does not crash the call; warning is logged and other hooks still fire", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const startedB: string[] = [];
    const bad: Hook = {
      name: "bad",
      onCallStart: () => {
        throw new Error("hook exploded");
      },
    };
    const good: Hook = {
      name: "good",
      onCallStart: () => {
        startedB.push("good");
      },
    };
    const dispatcher = new HookDispatcher([bad, good]);
    await dispatcher.run(baseCtx, async () => okResult);
    expect(startedB).toEqual(["good"]);
    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0];
    expect(firstCall?.[0]).toMatch(/hook "bad" failed in onCallStart/);
  });

  it("populates ctx.response in the onCallSuccess phase", async () => {
    let captured: { content?: string } | undefined;
    const hook: Hook = {
      name: "capture",
      onCallSuccess: (ctx) => {
        captured = { content: ctx.response?.content };
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await dispatcher.run(baseCtx, async () => okResult);
    expect(captured).toEqual({ content: "hello" });
  });

  it("populates ctx.error in the onCallError phase", async () => {
    let capturedCode: string | undefined;
    const hook: Hook = {
      name: "capture",
      onCallError: (ctx) => {
        capturedCode = ctx.error?.code;
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw new ProviderError("boom", "anthropic");
      }),
    ).rejects.toThrow();
    expect(capturedCode).toBe("PROVIDER_ERROR");
  });

  it("attempt counter starts at 1", async () => {
    let observedAttempt = 0;
    const hook: Hook = {
      name: "spy",
      onCallStart: (ctx) => {
        observedAttempt = ctx.attempt;
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await dispatcher.run(baseCtx, async () => okResult);
    expect(observedAttempt).toBe(1);
  });

  it("wraps non-LimnError throws into a ProviderError when populating ctx.error", async () => {
    let capturedCode: string | undefined;
    const hook: Hook = {
      name: "capture",
      onCallError: (ctx) => {
        capturedCode = ctx.error?.code;
      },
    };
    const dispatcher = new HookDispatcher([hook]);
    await expect(
      dispatcher.run(baseCtx, async () => {
        throw new Error("plain error");
      }),
    ).rejects.toThrow("plain error");
    expect(capturedCode).toBe("PROVIDER_ERROR");
  });

  it("HookDispatcher.newTraceId() returns a trc_-prefixed string", () => {
    const id = HookDispatcher.newTraceId();
    expect(id.startsWith("trc_")).toBe(true);
    expect(id.length).toBeGreaterThan("trc_".length);
  });
});
