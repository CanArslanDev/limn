/**
 * Live integration test against the real Anthropic API. Skipped automatically
 * when `ANTHROPIC_API_KEY` is not set, so CI (which never has the key) runs
 * the suite without touching the network. Local dev with a key in env runs
 * one cheap haiku-class call to confirm the adapter actually wires through.
 *
 * Lives in its own file (separate from `anthropic_provider.test.ts`) to keep
 * unit-level fixture replays and real-network calls visually distinct: the
 * fixture tests run on every commit; this one is opt-in via env var.
 */

import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic/anthropic_provider.js";

function readKey(): string | undefined {
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket notation under TS noPropertyAccessFromIndexSignature
  return process.env["ANTHROPIC_API_KEY"];
}
const HAS_KEY = readKey() !== undefined && readKey() !== "";

describe.skipIf(!HAS_KEY)("AnthropicProvider live", () => {
  it("returns non-empty text for a trivial prompt against claude-haiku-4-5", async () => {
    const provider = new AnthropicProvider();
    const response = await provider.request({
      model: "claude-haiku-4-5",
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
