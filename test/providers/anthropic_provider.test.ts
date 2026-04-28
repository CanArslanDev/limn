/**
 * Unit tests for the Anthropic provider adapter. The `@anthropic-ai/sdk`
 * module is mocked at module load so no network calls happen and so we can
 * drive every branch of the error-mapping logic deterministically.
 *
 * The mock mirrors the SDK's runtime shape: a default export that, when
 * `new`'d, exposes `messages.create()`, AND static error-class properties on
 * the default export (`Anthropic.AuthenticationError`, etc.). This shape is
 * confirmed by reading `node_modules/@anthropic-ai/sdk/index.d.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();

// Mock error-class shape mirroring `node_modules/@anthropic-ai/sdk/error.d.ts`:
// every Anthropic error is an `AnthropicError` -> `APIError` chain. We keep the
// same class hierarchy so `instanceof` checks against the mocked classes match
// the real-world chain a deployed app would see.
class MockAnthropicError extends Error {}
class MockAPIError extends MockAnthropicError {
  public readonly status: number | undefined;
  public readonly headers: Record<string, string> | undefined;
  public constructor(
    status: number | undefined,
    message: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
class MockAuthenticationError extends MockAPIError {}
class MockPermissionDeniedError extends MockAPIError {}
class MockRateLimitError extends MockAPIError {}
class MockInternalServerError extends MockAPIError {}
class MockAPIConnectionError extends MockAPIError {}
class MockAPIConnectionTimeoutError extends MockAPIConnectionError {}
class MockAPIUserAbortError extends MockAPIError {}

// Hoisted via vi.mock so the dynamic-import inside AnthropicProvider receives
// the mocked module instead of the real SDK. The real SDK exposes its error
// classes both as static properties on the default export AND as named
// exports off the module namespace; we mirror both so the adapter (which
// reads them as named exports) sees the mocked classes.
vi.mock("@anthropic-ai/sdk", () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  Object.assign(Anthropic, {
    APIError: MockAPIError,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
    RateLimitError: MockRateLimitError,
    InternalServerError: MockInternalServerError,
    APIConnectionError: MockAPIConnectionError,
    APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
    APIUserAbortError: MockAPIUserAbortError,
  });
  return {
    default: Anthropic,
    APIError: MockAPIError,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
    RateLimitError: MockRateLimitError,
    InternalServerError: MockInternalServerError,
    APIConnectionError: MockAPIConnectionError,
    APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
    APIUserAbortError: MockAPIUserAbortError,
  };
});

import {
  AuthError,
  ModelTimeoutError,
  ProviderError,
  RateLimitError,
} from "../../src/errors/index.js";
import { AnthropicProvider } from "../../src/providers/anthropic/anthropic_provider.js";
import type { ProviderRequest } from "../../src/providers/provider.js";

const baseRequest: ProviderRequest = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
};

beforeEach(() => {
  mockCreate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AnthropicProvider construction", () => {
  it("throws AuthError on request when no apiKey is configured", async () => {
    const provider = new AnthropicProvider(undefined);
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("does not touch the SDK when the apiKey is missing (no construct)", async () => {
    const provider = new AnthropicProvider(undefined);
    await provider.request(baseRequest).catch(() => undefined);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("AnthropicProvider happy path", () => {
  it("returns concatenated text + mapped usage + mapped stopReason", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.request(baseRequest);
    expect(response).toEqual({
      content: "hello",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 5, outputTokens: 7 },
    });
  });

  it("concatenates multiple text blocks in order", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Hello, " },
        { type: "text", text: "world!" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.request(baseRequest);
    expect(response.content).toBe("Hello, world!");
  });

  it("ignores non-text content blocks when concatenating", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "alpha " },
        { type: "tool_use", id: "tu_1", name: "search", input: {} },
        { type: "text", text: "beta" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.request(baseRequest);
    expect(response.content).toBe("alpha beta");
  });

  it("passes system through the top-level field, not via messages", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider("test-key");
    await provider.request({ ...baseRequest, system: "be brief" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [args] = mockCreate.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("rejects role:'system' inside messages with a ProviderError", async () => {
    const provider = new AnthropicProvider("test-key");
    await expect(
      provider.request({
        model: "claude-sonnet-4-6",
        messages: [{ role: "system", content: "stay calm" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("defaults max_tokens when caller omits it", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider("test-key");
    await provider.request(baseRequest);
    const [args] = mockCreate.mock.calls[0] ?? [];
    expect(args).toMatchObject({ max_tokens: 4096 });
  });
});

describe("AnthropicProvider stop_reason mapping", () => {
  it.each([
    ["end_turn", "end"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "end"],
    [null, "end"],
  ] as const)("maps SDK %s to ProviderResponse %s", async (sdkStop, mapped) => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "" }],
      stop_reason: sdkStop,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.request(baseRequest);
    expect(response.stopReason).toBe(mapped);
  });
});

describe("AnthropicProvider error mapping", () => {
  it("maps 401 AuthenticationError to AuthError", async () => {
    mockCreate.mockRejectedValueOnce(new MockAuthenticationError(401, "bad key"));
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 403 PermissionDeniedError to AuthError", async () => {
    mockCreate.mockRejectedValueOnce(new MockPermissionDeniedError(403, "forbidden"));
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 429 RateLimitError with retry-after header to RateLimitError(retryAfterMs)", async () => {
    mockCreate.mockRejectedValueOnce(
      new MockRateLimitError(429, "slow down", { "retry-after": "5" }),
    );
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request(baseRequest)).rejects.toMatchObject({
      retryAfterMs: 5000,
    });
    // Re-throw + re-catch to also check instanceof.
    mockCreate.mockRejectedValueOnce(
      new MockRateLimitError(429, "slow down", { "retry-after": "5" }),
    );
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps 429 without retry-after header to RateLimitError(retryAfterMs=undefined)", async () => {
    mockCreate.mockRejectedValueOnce(new MockRateLimitError(429, "slow down"));
    const provider = new AnthropicProvider("test-key");
    try {
      await provider.request(baseRequest);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBeUndefined();
    }
  });

  it("maps InternalServerError to ProviderError(provider='anthropic')", async () => {
    mockCreate.mockRejectedValueOnce(new MockInternalServerError(503, "upstream down"));
    const provider = new AnthropicProvider("test-key");
    try {
      await provider.request(baseRequest);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).provider).toBe("anthropic");
    }
  });

  it("maps APIConnectionError (transport) to ProviderError", async () => {
    mockCreate.mockRejectedValueOnce(new MockAPIConnectionError(undefined, "ECONNRESET"));
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(ProviderError);
  });

  it("maps APIConnectionTimeoutError to ModelTimeoutError", async () => {
    mockCreate.mockRejectedValueOnce(new MockAPIConnectionTimeoutError(undefined, "timeout"));
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request({ ...baseRequest, timeoutMs: 12345 })).rejects.toBeInstanceOf(
      ModelTimeoutError,
    );
  });

  it("maps a generic APIError to ProviderError", async () => {
    mockCreate.mockRejectedValueOnce(new MockAPIError(418, "teapot"));
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(ProviderError);
  });

  it("wraps an unknown throw in ProviderError", async () => {
    mockCreate.mockRejectedValueOnce(new Error("something else"));
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request(baseRequest)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("AnthropicProvider abort + timeout", () => {
  it("throws ModelTimeoutError when the SDK call exceeds timeoutMs", async () => {
    // The SDK call never resolves; the AbortController fires and the SDK
    // would throw an APIUserAbortError in real life. We simulate by waiting
    // on the signal, then rejecting with the SDK's abort-error subclass.
    mockCreate.mockImplementationOnce(
      (_args: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new MockAPIUserAbortError(undefined, "Request was aborted."));
          });
        }),
    );
    const provider = new AnthropicProvider("test-key");
    await expect(provider.request({ ...baseRequest, timeoutMs: 30 })).rejects.toBeInstanceOf(
      ModelTimeoutError,
    );
  });
});

describe("AnthropicProvider stream", () => {
  it("throws ProviderError noting batch 1.7", () => {
    const provider = new AnthropicProvider("test-key");
    expect(() => provider.stream(baseRequest)).toThrow(/batch 1\.7/);
  });
});
