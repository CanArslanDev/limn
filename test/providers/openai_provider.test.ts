/**
 * Unit tests for the OpenAI provider adapter. The real `openai` SDK runs
 * unmodified; we inject a fake `fetch` via the SDK's documented `fetch`
 * constructor option (see `node_modules/openai/index.d.ts` line 61: "Specify
 * a custom `fetch` function implementation."). That fake fetch replays JSON
 * fixtures from `test/fixtures/openai/` as HTTP responses, so the SDK
 * constructs its real error classes from real status codes and the adapter's
 * `instanceof` chain runs against the real classes a deployed app would see.
 *
 * Mirrors `anthropic_provider.test.ts` (batch 1.2) one-to-one. Differences
 * are limited to OpenAI shapes: `messages` carries `role: "system"` rather
 * than a top-level `system` field; `max_tokens` rather than `max_tokens` (same
 * snake_case, different default); image attachments use `image_url` content
 * parts rather than `image` blocks.
 *
 * The fetch-injection seam is the SDK's own test hook, so this exercises the
 * real status -> class mapping the live API produces. CLAUDE.md §11 forbids
 * patching SDK methods (`vi.mock`).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  ModelTimeoutError,
  ProviderError,
  RateLimitError,
} from "../../src/errors/index.js";
import { OpenAIProvider } from "../../src/providers/openai/openai_provider.js";
import type { ProviderRequest } from "../../src/providers/provider.js";
import { type FakeFetchResponse, makeFakeFetch } from "../_helpers/fake_fetch.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/openai");

/**
 * Convenience wrapper: build a single-response fake fetch pointed at the
 * OpenAI fixture directory. Most tests fire one SDK call per provider, so
 * the one-response shorthand keeps test bodies tight.
 */
function singleResponse(response: FakeFetchResponse): ReturnType<typeof makeFakeFetch> {
  return makeFakeFetch({ fixtureDir: FIXTURE_DIR, responses: [response] });
}

const baseRequest: ProviderRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
};

describe("OpenAIProvider construction", () => {
  it("throws AuthError on request when no apiKey is configured", async () => {
    // Construct with explicit `apiKey: undefined` so the env-var fallback is
    // bypassed even on developer machines that have OPENAI_API_KEY set.
    const provider = new OpenAIProvider({ apiKey: undefined });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("does not invoke fetch when the apiKey is missing", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: undefined, fetch });
    await provider.request(baseRequest).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("OpenAIProvider happy path", () => {
  it("returns content + mapped usage + mapped stopReason on success", async () => {
    const { fetch } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    const response = await provider.request(baseRequest);
    expect(response).toEqual({
      content: "Hello from fixture.",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("returns empty string when the assistant message content is null (tool_calls path)", async () => {
    const { fetch } = singleResponse({ fixture: "chat_tool_calls.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    const response = await provider.request(baseRequest);
    expect(response.content).toBe("");
    expect(response.stopReason).toBe("tool_use");
  });

  it("forwards system as a leading 'system' role message, not as a top-level field", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request({ ...baseRequest, system: "be brief" });
    expect(calls).toHaveLength(1);
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { system?: unknown; messages: ReadonlyArray<unknown> };
    // OpenAI does not accept a top-level system field on chat completions.
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("forwards temperature when supplied", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request({ ...baseRequest, temperature: 0.25 });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    expect((recorded.body as { temperature?: number }).temperature).toBe(0.25);
  });

  it("rejects role:'system' inside messages with a ProviderError", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await expect(
      provider.request({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "stay calm" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it("defaults max_tokens to 4096 when caller omits it", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request(baseRequest);
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    expect((recorded.body as { max_tokens: number }).max_tokens).toBe(4096);
  });

  it("forwards an explicit max_tokens override", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request({ ...baseRequest, maxTokens: 256 });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    expect((recorded.body as { max_tokens: number }).max_tokens).toBe(256);
  });

  it("forwards the model name through unchanged", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request(baseRequest);
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    expect((recorded.body as { model: string }).model).toBe("gpt-4o-mini");
  });
});

describe("OpenAIProvider stop_reason mapping", () => {
  it.each([
    ["chat_success.json", "end"],
    ["chat_max_tokens.json", "max_tokens"],
    ["chat_tool_calls.json", "tool_use"],
    ["chat_content_filter.json", "end"],
  ] as const)("maps fixture %s to ProviderResponse stopReason %s", async (fixture, mapped) => {
    const { fetch } = singleResponse({ fixture });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    const response = await provider.request(baseRequest);
    expect(response.stopReason).toBe(mapped);
  });
});

describe("OpenAIProvider error mapping", () => {
  it("maps HTTP 400 to ProviderError(retryable: false)", async () => {
    const { fetch } = singleResponse({ fixture: "error_400.json", status: 400 });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    try {
      await provider.request(baseRequest);
      throw new Error("expected ProviderError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(false);
    }
  });

  it("maps HTTP 401 to AuthError", async () => {
    const { fetch } = singleResponse({ fixture: "error_401.json", status: 401 });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps HTTP 403 to AuthError", async () => {
    const { fetch } = singleResponse({ fixture: "error_403.json", status: 403 });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps HTTP 429 with Retry-After header to RateLimitError(retryAfterMs)", async () => {
    const { fetch } = singleResponse({
      fixture: "error_429.json",
      status: 429,
      headers: { "retry-after": "5" },
    });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    try {
      await provider.request(baseRequest);
      throw new Error("expected RateLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(5000);
    }
  });

  it("maps HTTP 429 without Retry-After header to RateLimitError(retryAfterMs=undefined)", async () => {
    const { fetch } = singleResponse({ fixture: "error_429.json", status: 429 });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    try {
      await provider.request(baseRequest);
      throw new Error("expected RateLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBeUndefined();
    }
  });

  it("maps HTTP 500 to ProviderError(provider='openai', retryable: true)", async () => {
    const { fetch } = singleResponse({ fixture: "error_500.json", status: 500 });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    try {
      await provider.request(baseRequest);
      throw new Error("expected ProviderError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).provider).toBe("openai");
      expect((err as ProviderError).retryable).toBe(true);
    }
  });

  it("maps an unhandled status (HTTP 418) to ProviderError via the bare APIError fallthrough", async () => {
    const { fetch } = singleResponse({ fixture: "error_418.json", status: 418 });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("OpenAIProvider abort + timeout", () => {
  it("throws ModelTimeoutError when the SDK call exceeds timeoutMs", async () => {
    // Fake fetch hangs (delayMs > timeoutMs). The adapter's AbortController
    // fires; the SDK observes the AbortError from fetch and surfaces
    // APIConnectionTimeoutError (or APIUserAbortError), which the adapter
    // maps to ModelTimeoutError.
    const { fetch } = singleResponse({
      fixture: "chat_success.json",
      delayMs: 5_000,
    });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await expect(provider.request({ ...baseRequest, timeoutMs: 30 })).rejects.toBeInstanceOf(
      ModelTimeoutError,
    );
  });
});

describe("OpenAIProvider attachments", () => {
  // 1x1 transparent PNG. The exact bytes are not asserted; only that the
  // adapter forwards `data:image/png;base64,...` over the wire.
  const pngBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );

  it("emits an image_url part before the text on the first user message", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_with_image.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request({
      ...baseRequest,
      attachments: [
        { kind: "image", source: { type: "base64", data: pngBuffer, mimeType: "image/png" } },
      ],
    });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { messages: ReadonlyArray<{ role: string; content: unknown }> };
    expect(body.messages).toHaveLength(1);
    const first = body.messages[0];
    if (first === undefined) throw new Error("expected one message");
    expect(first.role).toBe("user");
    expect(first.content).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${pngBuffer.toString("base64")}` },
      },
      { type: "text", text: "hi" },
    ]);
  });

  it("preserves attachment order (multiple base64 images before the text)", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_with_image.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request({
      ...baseRequest,
      attachments: [
        { kind: "image", source: { type: "base64", data: pngBuffer, mimeType: "image/png" } },
        { kind: "image", source: { type: "base64", data: pngBuffer, mimeType: "image/jpeg" } },
        { kind: "image", source: { type: "base64", data: pngBuffer, mimeType: "image/gif" } },
      ],
    });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { messages: ReadonlyArray<{ role: string; content: unknown }> };
    const first = body.messages[0];
    if (first === undefined) throw new Error("expected one message");
    const content = first.content as ReadonlyArray<{ type: string }>;
    expect(content).toHaveLength(4);
    expect(content[0]?.type).toBe("image_url");
    expect(content[1]?.type).toBe("image_url");
    expect(content[2]?.type).toBe("image_url");
    expect(content[3]?.type).toBe("text");
    // Spot-check the second image (base64 with image/jpeg media type).
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${pngBuffer.toString("base64")}` },
    });
  });

  it("keeps content as a string when no attachments are supplied", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_success.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request(baseRequest);
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { messages: ReadonlyArray<{ role: string; content: unknown }> };
    const first = body.messages[0];
    if (first === undefined) throw new Error("expected one message");
    expect(first.content).toBe("hi");
  });

  it("attaches images only to the first user message in a multi-message request", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_with_image.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ],
      attachments: [
        { kind: "image", source: { type: "base64", data: pngBuffer, mimeType: "image/png" } },
      ],
    });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { messages: ReadonlyArray<{ role: string; content: unknown }> };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]?.content).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${pngBuffer.toString("base64")}` },
      },
      { type: "text", text: "first" },
    ]);
    expect(body.messages[1]?.content).toBe("ack");
    expect(body.messages[2]?.content).toBe("second");
  });

  it("attaches images on the original first user message even when system was prepended", async () => {
    // System prepending happens AFTER attachment placement so attachments still
    // land on the original first user message (which is now index 1 of the
    // wire-level messages array). This guards the contract that the adapter
    // routes attachments to the first `role: "user"` in the input messages,
    // not to the first message at index 0 of the final SDK array.
    const { fetch, calls } = singleResponse({ fixture: "chat_with_image.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    await provider.request({
      ...baseRequest,
      system: "be brief",
      attachments: [
        { kind: "image", source: { type: "base64", data: pngBuffer, mimeType: "image/png" } },
      ],
    });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { messages: ReadonlyArray<{ role: string; content: unknown }> };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    const userMessage = body.messages[1];
    if (userMessage === undefined) throw new Error("expected user message");
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${pngBuffer.toString("base64")}` },
      },
      { type: "text", text: "hi" },
    ]);
  });

  it("accepts a raw Uint8Array (not just Buffer) as the image data", async () => {
    const { fetch, calls } = singleResponse({ fixture: "chat_with_image.json" });
    const provider = new OpenAIProvider({ apiKey: "test-key", fetch });
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    await provider.request({
      ...baseRequest,
      attachments: [
        { kind: "image", source: { type: "base64", data: raw, mimeType: "image/png" } },
      ],
    });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { messages: ReadonlyArray<{ role: string; content: unknown }> };
    const first = body.messages[0];
    if (first === undefined) throw new Error("expected one message");
    const content = first.content as ReadonlyArray<unknown>;
    expect(content[0]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from(raw).toString("base64")}` },
    });
  });
});

describe("OpenAIProvider requestStream", () => {
  it("returns a {stream, usage} pair the dispatcher can consume", () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const result = provider.requestStream(baseRequest);
    expect(result.stream).toBeDefined();
    expect(typeof (result.stream as AsyncIterable<string>)[Symbol.asyncIterator]).toBe("function");
    expect(result.usage).toBeInstanceOf(Promise);
    // Suppress unhandled rejection: this test never iterates the stream
    // (and thus never triggers the SDK call), so we discard both channels.
    result.usage.catch(() => {
      // intentional swallow: this test never iterates the stream
    });
  });

  it("surfaces missing apiKey via AuthError on first iterator next()", async () => {
    const provider = new OpenAIProvider({ apiKey: undefined });
    const { stream, usage } = provider.requestStream(baseRequest);
    usage.catch(() => {
      // intentional swallow: assert is on iterator next()
    });
    const iter = (stream as AsyncIterable<string>)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBeInstanceOf(AuthError);
  });
});
