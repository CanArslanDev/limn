/**
 * End-to-end trace pipeline smoke. Drives `ai.ask` against a registered
 * `MockProvider`, points the trace sink at an isolated tmp directory, and
 * asserts that the call produces exactly one JSON file with the documented
 * `TraceRecord` shape AND that an Anthropic-shaped key smuggled into the
 * prompt is replaced with `[REDACTED]` in the persisted record (with a
 * `redactedFields` locator naming where the redaction happened).
 *
 * This is the canonical RED -> GREEN target for batch 1.4. The test
 * deliberately uses the production hook stack (RedactionHook + TraceHook
 * + FileSystemTraceSink) and only swaps the trace directory so the
 * production wiring is what is being verified.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDispatcherFactoryForTests, ai, buildDefaultDispatcher } from "../../src/client/ai.js";
import { DEFAULT_CONFIG } from "../../src/config/limn_config.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";
import type { TraceRecord } from "../../src/trace/trace.js";

const ANT_KEY = "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE12345678";

describe("ai.ask trace integration (FileSystemTraceSink + RedactionHook)", () => {
  let mock: MockProvider;
  let previous: ReturnType<typeof getProvider> | undefined;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "limn-trace-int-"));
    try {
      previous = getProvider("anthropic");
    } catch {
      previous = undefined;
    }
    mock = new MockProvider("anthropic");
    registerProvider("anthropic", mock);

    // Inject a factory that builds the production dispatcher with the
    // trace dir pinned to the isolated tmp directory. Everything else
    // (RedactionHook, TraceHook, retry strategy) flows through the real
    // production wiring so the integration covers the same code path
    // users will exercise.
    __setDispatcherFactoryForTests((ctx) =>
      buildDefaultDispatcher(ctx, {
        ...DEFAULT_CONFIG,
        trace: { ...DEFAULT_CONFIG.trace, dir },
      }),
    );
  });

  afterEach(async () => {
    mock.reset();
    if (previous !== undefined) {
      registerProvider("anthropic", previous);
    } else {
      unregisterProvider("anthropic");
    }
    __setDispatcherFactoryForTests(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one JSON trace file per call with the documented TraceRecord shape", async () => {
    mock.pushResponse({
      content: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 4, outputTokens: 2 },
    });

    await ai.ask("hi");

    const files = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fileName = files[0];
    expect(fileName).toBeDefined();
    if (fileName === undefined) return;
    const raw = await readFile(join(dir, fileName), "utf8");
    const record = JSON.parse(raw) as TraceRecord;

    expect(record.id).toMatch(/^trc_[0-9a-f-]{36}$/);
    expect(record.kind).toBe("ask");
    expect(record.provider).toBe("anthropic");
    expect(record.model).toBe("claude-sonnet-4-6");
    expect(record.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
    expect(record.attempts).toBe(1);
    expect(record.redactedFields).toEqual([]);
    expect(typeof record.latencyMs).toBe("number");
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.error).toBeUndefined();
  });

  it("redacts an sk-ant- key smuggled through the prompt and surfaces the locator", async () => {
    mock.pushResponse({
      content: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.ask(`Use ${ANT_KEY} to authenticate`);

    const files = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fileName = files[0];
    expect(fileName).toBeDefined();
    if (fileName === undefined) return;
    const raw = await readFile(join(dir, fileName), "utf8");
    const record = JSON.parse(raw) as TraceRecord;

    // The key is gone from the persisted file.
    expect(raw).not.toContain("sk-ant-FAKEFAKE");
    expect(raw).toContain("[REDACTED]");

    // The locator names the field path where the redaction happened.
    expect(record.redactedFields).toContain("request.messages.0.content");

    // The cleaned request preserves surrounding prose.
    const persisted = record.request as { messages: Array<{ content: string }> };
    expect(persisted.messages[0]?.content).toBe("Use [REDACTED] to authenticate");
  });
});
