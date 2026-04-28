/**
 * Shared fake-`fetch` builder for provider-adapter unit tests. Each adapter
 * (Anthropic today, OpenAI in batch 1.6) exercises the real SDK against
 * recorded JSON fixtures by injecting this fake into the SDK's `fetch`
 * constructor option. The SDK then constructs its real error classes from
 * the real HTTP status codes the fixture replays return, so the adapter's
 * `instanceof` mapping is tested against the same hierarchy a deployed app
 * would see.
 *
 * Usage:
 *
 * ```ts
 * const { fetch, calls } = makeFakeFetch({
 *   fixtureDir: join(HERE, "../fixtures/anthropic"),
 *   responses: [{ fixture: "messages_success.json" }],
 * });
 * const provider = new AnthropicProvider({ apiKey: "test-key", fetch });
 * await provider.request(req);
 * expect(calls[0]?.body).toMatchObject({ model: "claude-sonnet-4-6" });
 * ```
 *
 * The `responses` array is consumed in order. If the test fetch fires more
 * times than the array has entries, the call rejects with a clear error
 * naming the fixture directory + the call index, so an over-firing SDK does
 * not silently fall through to a network attempt.
 *
 * The `calls` view is a `readonly` snapshot over an internal mutable array
 * (mirrors the MockProvider pattern at `src/providers/_mock/mock_provider.ts`):
 * tests can read `calls[i]` and `calls.length` but cannot push/shift/splice.
 *
 * The architecture test only governs `src/`; this file lives under `test/`
 * so it carries no layer-rule constraint.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One programmed fetch response. The fixture file is read from `fixtureDir`
 * each time the fake fetch is invoked, so a single fixture file may be
 * referenced by multiple entries without copy-paste.
 */
export interface FakeFetchResponse {
  /** HTTP status to return. Defaults to 200. */
  readonly status?: number;
  /** Fixture file name (relative to `fixtureDir`). */
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

export interface FakeFetchOptions {
  /** Absolute directory containing fixture JSON files. */
  readonly fixtureDir: string;
  /** Programmed responses, consumed in order on each fetch invocation. */
  readonly responses: ReadonlyArray<FakeFetchResponse>;
}

/** One captured outgoing call for after-the-fact assertion. */
export interface RecordedFetchCall {
  readonly url: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeFetchHandle {
  /** Drop-in replacement for `globalThis.fetch`, structurally compatible with SDK fetch options. */
  readonly fetch: typeof globalThis.fetch;
  /** Calls captured so far. Readonly view over an internal array. */
  readonly calls: ReadonlyArray<RecordedFetchCall>;
}

/**
 * Build a fake `fetch` that replays a sequence of fixture-backed responses.
 * Returns the function plus a `calls` view tests can inspect.
 *
 * The function is typed as `typeof globalThis.fetch` so SDK `fetch` options
 * (Anthropic's `Core.Fetch`, OpenAI's `Fetch`) accept it without a cast.
 */
export function makeFakeFetch(opts: FakeFetchOptions): FakeFetchHandle {
  const calls: RecordedFetchCall[] = [];
  let nextIndex = 0;

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

    const programmed = opts.responses[nextIndex];
    if (programmed === undefined) {
      throw new Error(
        `makeFakeFetch: fetch invoked ${nextIndex + 1} times but only ${opts.responses.length} responses programmed (fixtureDir=${opts.fixtureDir}).`,
      );
    }
    nextIndex += 1;

    if (programmed.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, programmed.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          // The standard `fetch` rejects with an AbortError when the signal
          // fires; SDKs surface this as their connection-timeout class when
          // the cause was an internal timeout AbortController.
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }

    const fixturePath = join(opts.fixtureDir, programmed.fixture);
    const raw = await readFile(fixturePath, "utf8");
    // Validate the fixture is well-formed JSON, then re-stringify so the
    // response body is canonical (no trailing newlines, no comments).
    const parsed = JSON.parse(raw) as unknown;
    const body = JSON.stringify(parsed);
    return new Response(body, {
      status: programmed.status ?? 200,
      headers: { "content-type": "application/json", ...(programmed.headers ?? {}) },
    });
  };

  return { fetch: fn, calls };
}
