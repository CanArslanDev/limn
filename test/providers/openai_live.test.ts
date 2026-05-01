/**
 * Live integration test against the real OpenAI API. Skipped automatically
 * when `OPENAI_API_KEY` is not set, so CI (which never has the key) runs
 * the suite without touching the network. Local dev with a key in env runs
 * one cheap mini-class call to confirm the adapter actually wires through.
 *
 * Lives in its own file (separate from `openai_provider.test.ts`) to keep
 * unit-level fixture replays and real-network calls visually distinct: the
 * fixture tests run on every commit; this one is opt-in via env var.
 */

import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/providers/openai/openai_provider.js";

function readKey(): string | undefined {
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket notation under TS noPropertyAccessFromIndexSignature
  return process.env["OPENAI_API_KEY"];
}
const KEY = readKey();
const HAS_KEY = KEY !== undefined && KEY !== "";

describe.skipIf(!HAS_KEY)("OpenAIProvider live", () => {
  it("returns non-empty text for a trivial prompt against gpt-4o-mini", async () => {
    const provider = new OpenAIProvider();
    const response = await provider.request({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say 'pong' (just the word)." }],
      maxTokens: 16,
      timeoutMs: 30_000,
    });
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
    expect(response.stopReason).toMatch(/end|max_tokens/);
  });
});
