/**
 * Unit tests for the Anthropic provider adapter. The real `@anthropic-ai/sdk`
 * runs unmodified; we inject a fake `fetch` via the SDK's documented
 * `fetch` constructor option (see `node_modules/@anthropic-ai/sdk/index.d.ts`
 * line 43: "Specify a custom `fetch` function implementation."). That fake
 * fetch replays JSON fixtures from `test/fixtures/anthropic/` as HTTP
 * responses, so the SDK constructs its real error classes from real status
 * codes and the adapter's `instanceof` chain runs against the real classes
 * a deployed app would see.
 *
 * Why this approach instead of `vi.mock("@anthropic-ai/sdk")`: CLAUDE.md
 * §11 forbids patching SDK methods. The fetch-injection seam is the SDK's
 * own test hook, and exercising it keeps unit tests honest about the SDK's
 * actual behavior (status -> class mapping, header capitalization, retry
 * disable semantics) instead of hand-rolling a fake-class hierarchy that
 * inevitably drifts from the real one.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthError,
  ModelTimeoutError,
  ProviderError,
  RateLimitError,
} from "../../src/errors/index.js";
import { AnthropicProvider } from "../../src/providers/anthropic/anthropic_provider.js";
import type { ProviderRequest } from "../../src/providers/provider.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/anthropic");

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(join(FIXTURE_DIR, name), "utf8");
  return JSON.parse(raw) as unknown;
}

interface FakeFetchOptions {
  /** HTTP status to return. Defaults to 200. */
  readonly status?: number;
  /** Fixture file name under test/fixtures/anthropic/. */
  readonly fixture: string;
  /** Extra response headers (lowercase keys recommended). */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * If set, the fake fetch waits this many ms before resolving. Used to
   * test the AbortController-driven timeout path: when the SDK's signal
   * fires before the delay elapses, fetch rejects with an AbortError.
   */
  readonly delayMs?: number;
}

interface RecordedCall {
  readonly url: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Build a fake `fetch` that replays a fixture. Returns the function plus a
 * `calls` array the test can inspect after the SDK call returns. The function
 * is typed as `typeof globalThis.fetch` so the SDK's `Core.Fetch` parameter
 * (structurally `(url: RequestInfo, init?: RequestInit) => Promise<Response>`)
 * accepts it.
 */
function makeFakeFetch(opts: FakeFetchOptions): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: ReadonlyArray<RecordedCall>;
} {
  const calls: RecordedCall[] = [];
  const fn: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    let parsedBody: unknown;
    if (init?.body !== undefined && init.body !== null) {
      try {
        parsedBody = JSON.parse(init.body as string);
      } catch {
        parsedBody = init.body;
      }
    }
    const headerRecord: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders !== undefined) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headerRecord[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const pair of rawHeaders as unknown as ReadonlyArray<readonly [string, string]>) {
          const [k, v] = pair;
          headerRecord[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
          headerRecord[k.toLowerCase()] = v;
        }
      }
    }
    calls.push({ url, body: parsedBody, headers: headerRecord });

    if (opts.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          // The standard `fetch` rejects with an AbortError when the signal
          // fires; the SDK then surfaces it as APIConnectionTimeoutError if
          // the cause was its internal timeout (see core.js makeRequest).
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }

    const body = JSON.stringify(await loadFixture(opts.fixture));
    return new Response(body, {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    });
  };
  return { fetch: fn, calls };
}

const baseRequest: ProviderRequest = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
};

afterEach(() => {
  // No-op today; reserved for future fake-timer suites.
});

describe("AnthropicProvider construction", () => {
  it("throws AuthError on request when no apiKey is configured", async () => {
    // Construct without options; readApiKeyFromEnv() returns undefined when
    // the env var is missing. We assume the test runner does not set
    // ANTHROPIC_API_KEY (CI never does). If a developer runs locally with
    // the var set, the request still throws AuthError because the fake
    // fetch never gets a chance: the constructor variant we use here
    // explicitly passes `apiKey: undefined`.
    const provider = new AnthropicProvider({ apiKey: undefined });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("does not invoke fetch when the apiKey is missing", async () => {
    const { fetch, calls } = makeFakeFetch({ fixture: "messages_success.json" });
    const provider = new AnthropicProvider({ apiKey: undefined, fetch });
    await provider.request(baseRequest).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("AnthropicProvider happy path", () => {
  it("returns concatenated text + mapped usage + mapped stopReason on success", async () => {
    const { fetch } = makeFakeFetch({ fixture: "messages_success.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    const response = await provider.request(baseRequest);
    expect(response).toEqual({
      content: "Hello from fixture.",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("concatenates multiple text blocks in order", async () => {
    const { fetch } = makeFakeFetch({ fixture: "messages_multi_text.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    const response = await provider.request(baseRequest);
    expect(response.content).toBe("Hello, world!");
  });

  it("ignores non-text content blocks when concatenating", async () => {
    const { fetch } = makeFakeFetch({ fixture: "messages_with_tool_use.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    const response = await provider.request(baseRequest);
    expect(response.content).toBe("alpha beta");
  });

  it("forwards system through the top-level field, not via messages", async () => {
    const { fetch, calls } = makeFakeFetch({ fixture: "messages_success.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await provider.request({ ...baseRequest, system: "be brief" });
    expect(calls).toHaveLength(1);
    const recorded = calls[0];
    expect(recorded).toBeDefined();
    if (recorded === undefined) throw new Error("expected one call");
    const body = recorded.body as { system?: string; messages: unknown };
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("forwards temperature when supplied", async () => {
    const { fetch, calls } = makeFakeFetch({ fixture: "messages_success.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await provider.request({ ...baseRequest, temperature: 0.25 });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    expect((recorded.body as { temperature?: number }).temperature).toBe(0.25);
  });

  it("rejects role:'system' inside messages with a ProviderError", async () => {
    const { fetch, calls } = makeFakeFetch({ fixture: "messages_success.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await expect(
      provider.request({
        model: "claude-sonnet-4-6",
        messages: [{ role: "system", content: "stay calm" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it("defaults max_tokens to 4096 when caller omits it", async () => {
    const { fetch, calls } = makeFakeFetch({ fixture: "messages_success.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await provider.request(baseRequest);
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    expect((recorded.body as { max_tokens: number }).max_tokens).toBe(4096);
  });

  it("forwards an explicit max_tokens override", async () => {
    const { fetch, calls } = makeFakeFetch({ fixture: "messages_success.json" });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await provider.request({ ...baseRequest, maxTokens: 256 });
    const recorded = calls[0];
    if (recorded === undefined) throw new Error("expected one call");
    expect((recorded.body as { max_tokens: number }).max_tokens).toBe(256);
  });
});

describe("AnthropicProvider stop_reason mapping", () => {
  it.each([
    ["messages_success.json", "end"],
    ["messages_max_tokens.json", "max_tokens"],
    ["messages_with_tool_use.json", "tool_use"],
    ["messages_stop_sequence.json", "end"],
    ["messages_null_stop_reason.json", "end"],
  ] as const)("maps fixture %s to ProviderResponse stopReason %s", async (fixture, mapped) => {
    const { fetch } = makeFakeFetch({ fixture });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    const response = await provider.request(baseRequest);
    expect(response.stopReason).toBe(mapped);
  });
});

describe("AnthropicProvider error mapping", () => {
  it("maps HTTP 401 to AuthError", async () => {
    const { fetch } = makeFakeFetch({ fixture: "error_401.json", status: 401 });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps HTTP 403 to AuthError", async () => {
    const { fetch } = makeFakeFetch({ fixture: "error_403.json", status: 403 });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps HTTP 429 with Retry-After header to RateLimitError(retryAfterMs)", async () => {
    const { fetch } = makeFakeFetch({
      fixture: "error_429.json",
      status: 429,
      headers: { "retry-after": "5" },
    });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    try {
      await provider.request(baseRequest);
      throw new Error("expected RateLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(5000);
    }
  });

  it("maps HTTP 429 without Retry-After header to RateLimitError(retryAfterMs=undefined)", async () => {
    const { fetch } = makeFakeFetch({ fixture: "error_429.json", status: 429 });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    try {
      await provider.request(baseRequest);
      throw new Error("expected RateLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBeUndefined();
    }
  });

  it("maps HTTP 500 to ProviderError(provider='anthropic')", async () => {
    const { fetch } = makeFakeFetch({ fixture: "error_500.json", status: 500 });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    try {
      await provider.request(baseRequest);
      throw new Error("expected ProviderError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).provider).toBe("anthropic");
    }
  });

  it("maps an unhandled status (HTTP 418) to ProviderError via the bare APIError fallthrough", async () => {
    const { fetch } = makeFakeFetch({ fixture: "error_418.json", status: 418 });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("AnthropicProvider abort + timeout", () => {
  it("throws ModelTimeoutError when the SDK call exceeds timeoutMs", async () => {
    // Fake fetch hangs (delayMs > timeoutMs). The adapter's AbortController
    // fires; the SDK observes the AbortError from fetch and surfaces
    // APIConnectionTimeoutError, which the adapter maps to ModelTimeoutError.
    const { fetch } = makeFakeFetch({
      fixture: "messages_success.json",
      delayMs: 5_000,
    });
    const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
    await expect(provider.request({ ...baseRequest, timeoutMs: 30 })).rejects.toBeInstanceOf(
      ModelTimeoutError,
    );
  });
});

describe("AnthropicProvider stream", () => {
  it("throws ProviderError noting batch 1.7", () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    expect(() => provider.stream(baseRequest)).toThrow(/batch 1\.7/);
  });
});
