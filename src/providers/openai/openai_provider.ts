/**
 * OpenAI provider adapter. Wraps `openai`'s chat completions API.
 *
 * The SDK is a peer dependency. Consumers who use only Anthropic never need
 * it installed; we lazy-import via `await import("openai")` on first request
 * to avoid pulling OpenAI into bundles that do not need it.
 *
 * Error mapping (from the SDK's APIError subclasses + transport errors):
 * - 401 / 403 -> AuthError (do not retry; the key is bad)
 * - 429 -> RateLimitError(retryAfterMs from `Retry-After` header)
 * - 5xx + network errors -> ProviderError("openai", cause) with default
 *   `retryable: true` so the retry strategy backs off and tries again.
 * - APIUserAbortError + APIConnectionTimeoutError -> ModelTimeoutError(timeoutMs, cause)
 * - Other 4xx (BadRequestError, NotFoundError, ConflictError,
 *   UnprocessableEntityError, plus the bare APIError fallthrough for
 *   unfamiliar statuses) surface as ProviderError with `retryable: false`:
 *   client-side bugs are deterministic, retrying just burns attempts.
 *
 * Construction reads `OPENAI_API_KEY` from process.env when no explicit key
 * is supplied. If the key is missing, request() throws AuthError on first
 * invocation rather than at construction time; this lets test code construct
 * + register a provider without a real key.
 *
 * Differences from the Anthropic adapter:
 * - System instructions ride as a `{ role: "system", content }` message
 *   prepended to the messages array. OpenAI's chat completions endpoint
 *   does not accept a top-level `system` field.
 * - Image attachments translate to `{ type: "image_url", image_url: { url:
 *   "data:<mime>;base64,<base64>" } }` content parts. The OpenAI SDK
 *   accepts URL-form image_urls too, but our shared `ImageSource` type is
 *   base64-only until the broader portability story lands; URL form awaits
 *   that batch.
 *
 * Provider boundary note: this file is the documented SDK-boundary cast
 * site for the OpenAI SDK. The SDK's `chat.completions.create()` overloads
 * route through a stream-or-completion union that TypeScript narrows poorly
 * through dynamic import, so we cast the cached client to the precise
 * structural shape of the one method we call and re-narrow the response
 * with `SdkChatCompletionResponse` immediately. The cast stays a tight,
 * named structural type rather than `any` so a future SDK signature change
 * surfaces as a type error here instead of silently propagating.
 */

import type { Attachment, ChatMessage } from "../../client/options.js";
import { AuthError, ModelTimeoutError, ProviderError, RateLimitError } from "../../errors/index.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamResult,
} from "../provider.js";

/**
 * Constructor options for {@link OpenAIProvider}. Options-object shape
 * (rather than positional arguments) lets future additions land without
 * breaking call sites.
 */
export interface OpenAIProviderOptions {
  /**
   * OpenAI API key. Defaults to `process.env.OPENAI_API_KEY` when the
   * `apiKey` field is omitted entirely. Passing the field explicitly with
   * `undefined` bypasses the env-var fallback; this is useful when tests
   * want to assert the missing-key behavior on a developer machine that
   * has `OPENAI_API_KEY` set in its shell. The constructor uses an
   * `"apiKey" in options` check (not `??`) to distinguish the two paths.
   */
  readonly apiKey?: string | undefined;
  /**
   * Optional `fetch` implementation forwarded to the underlying SDK. The
   * SDK's `ClientOptions.fetch` is typed as `Core.Fetch`, structurally
   * compatible with the standard `fetch`. Test code injects a fake `fetch`
   * that replays recorded fixtures from `test/fixtures/openai/`; production
   * code omits this and the SDK uses the global `fetch`.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Subset of the OpenAI SDK's `ChatCompletion` shape that the adapter
 * consumes. The full SDK type is much larger; we narrow to just the fields
 * we map so a future SDK addition cannot silently change behavior.
 */
interface SdkChatCompletionResponse {
  readonly choices: ReadonlyArray<{
    readonly message: {
      readonly role: string;
      readonly content: string | null;
    };
    readonly finish_reason: SdkFinishReason | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  };
}

type SdkFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

/**
 * Structural narrowing of OpenAI's `ChatCompletionChunk` shape that the
 * streaming adapter consumes. The SDK type is much wider; we narrow to the
 * three fields we read so a future SDK reorganization surfaces here as a
 * type error rather than silently mis-routing tokens.
 */
interface SdkChatCompletionChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string | null };
  }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number } | null;
}

/**
 * Subset of the SDK error-class surface the adapter touches. The SDK exposes
 * each class as a static property on the default export AND as a named
 * export; we use the static-property form so the import surface is one
 * symbol.
 */
interface SdkErrorClasses {
  readonly APIError: new (...args: unknown[]) => Error;
  readonly AuthenticationError: new (...args: unknown[]) => Error;
  readonly PermissionDeniedError: new (...args: unknown[]) => Error;
  readonly RateLimitError: new (...args: unknown[]) => Error;
  readonly InternalServerError: new (...args: unknown[]) => Error;
  readonly APIConnectionError: new (...args: unknown[]) => Error;
  readonly APIConnectionTimeoutError: new (...args: unknown[]) => Error;
  readonly APIUserAbortError: new (...args: unknown[]) => Error;
}

/**
 * Loosened RateLimitError shape used at the catch site. The SDK's
 * `RateLimitError` carries a `headers` bag that may or may not include
 * `retry-after`; we read it defensively because header capitalization
 * varies across runtimes.
 */
interface SdkRateLimitErrorLike extends Error {
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Read `OPENAI_API_KEY` from `process.env`. Pulled into a helper so the one
 * place that needs the bracket-notation lint suppression (TS forbids
 * dot-access on the index-signature `process.env` under
 * `noPropertyAccessFromIndexSignature`, but Biome's `useLiteralKeys` rule
 * wants dot access) lives in one spot rather than at every call site.
 */
function readApiKeyFromEnv(): string | undefined {
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket notation under TS noPropertyAccessFromIndexSignature
  return process.env["OPENAI_API_KEY"];
}

/**
 * Cached SDK state: the constructed client plus the error-class table. Both
 * are populated together by `ensureClient()` and assigned as one atomic
 * field write so a concurrent caller sees either "nothing cached" (and
 * waits its turn) or "fully cached" (and proceeds). Splitting them into two
 * independent mutable fields would invite a "client cached but errors not
 * yet" window during interleaved `request()` calls.
 */
interface CachedSdkState {
  readonly client: unknown;
  readonly errors: SdkErrorClasses;
}

export class OpenAIProvider implements Provider {
  public readonly name = "openai" as const;

  // Lazy-cached SDK state. First request() call populates it; subsequent
  // calls reuse. The two halves (client + error-class table) live in one
  // object so they are observed together; see CachedSdkState's JSDoc.
  private state: CachedSdkState | undefined;

  private readonly apiKey: string | undefined;
  private readonly fetchOverride: typeof globalThis.fetch | undefined;

  /**
   * Construct a provider. Without arguments the constructor reads
   * `OPENAI_API_KEY` from `process.env` and uses the global `fetch`. Tests
   * pass `{ apiKey: "test-key", fetch: fakeFetch }` so they need not mutate
   * the process environment and can replay JSON fixtures without touching
   * the network. The `apiKey` field is `keyof`-present in options even when
   * `undefined`; supplying `{ apiKey: undefined }` explicitly skips the
   * env-var fallback (useful for asserting the missing-key behavior on
   * developer machines that have the var set).
   */
  public constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = "apiKey" in options ? options.apiKey : readApiKeyFromEnv();
    this.fetchOverride = options.fetch;
  }

  /**
   * Translate a Limn `ProviderRequest` into an OpenAI SDK call, then map
   * the SDK's response (or thrown error) into the Limn shapes the rest of
   * the library consumes.
   *
   * OpenAI's chat completions API does not accept a top-level `system`
   * field; system instructions ride as a `{ role: "system", content }`
   * message prepended to the messages array. The `ai.ask` wiring already
   * routes user-supplied system instructions to `req.system`. If a `role:
   * "system"` message slips into `req.messages` (e.g. a direct adapter
   * caller), we throw a `ProviderError` with a fix-it message instead of
   * silently coercing it; silent coercion would mask user bugs in `ai.chat`
   * once that lands.
   */
  public async request(req: ProviderRequest): Promise<ProviderResponse> {
    // Auth check before any SDK touch. Two reasons:
    //   1. Faster failure for the common "forgot to set the key" mistake.
    //   2. Avoids importing the SDK module just to immediately throw.
    if (this.apiKey === undefined || this.apiKey === "") {
      throw new AuthError("OPENAI_API_KEY env var not set; cannot reach OpenAI.");
    }

    // Defensive guard for direct adapter callers. See JSDoc above. Marked
    // `retryable: false` because this is a caller bug (wrong message shape),
    // not a transient fault: re-issuing the same request will fail the same
    // way. The retry strategy honors the flag and rethrows immediately.
    for (const m of req.messages) {
      if (m.role === "system") {
        throw new ProviderError(
          "OpenAI does not accept role 'system' inside ProviderRequest.messages here; pass system instructions via ProviderRequest.system instead.",
          "openai",
          undefined,
          false,
        );
      }
    }

    const state = await this.ensureState();
    const { errors: errs } = state;

    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    // Build the SDK request. Optional fields are spread conditionally so we
    // never send `undefined` over the wire.
    const sdkRequest = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: buildSdkMessages(req.messages, req.attachments, req.system),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    };

    try {
      // SDK-boundary cast. The SDK's overloaded `create()` routes through a
      // stream/non-stream union that does not narrow cleanly out of dynamic
      // import. We cast the cached `unknown` client to the precise structural
      // shape of the one method we use; the response is typed as
      // SdkChatCompletionResponse on the same line. No `any` escapes this
      // site.
      const sdkClient = state.client as {
        readonly chat: {
          readonly completions: {
            create(req: unknown, opts: { signal: AbortSignal }): Promise<SdkChatCompletionResponse>;
          };
        };
      };
      const sdkResponse = await sdkClient.chat.completions.create(sdkRequest, {
        signal: ac.signal,
      });
      return mapSdkResponse(sdkResponse);
    } catch (err) {
      throw mapSdkError(err, errs, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Begin a streaming request against OpenAI's `chat.completions.create({
   * stream: true, stream_options: { include_usage: true } })` endpoint.
   * Returns the two-channel result from the Provider contract: `stream` is
   * the iterator of textual deltas, `usage` is the promise that resolves
   * once the stream drains with cumulative tokens.
   *
   * OpenAI's stream emits `ChatCompletionChunk`s; each chunk has a
   * `choices[0].delta.content` field that carries the textual delta when
   * present (it is null for the first chunk and for tool-call chunks).
   * Setting `stream_options.include_usage: true` makes the SDK emit a
   * final chunk with no choices and a populated `usage` object; we read
   * tokens from that chunk to resolve the usage promise.
   *
   * Error mapping mirrors `request()`: SDK-level errors translate through
   * `mapSdkError`. Pre-stream failures (auth, missing peer dep) surface by
   * making the iterator's first `next()` throw; the dispatcher's stream
   * loop treats that as a first-chunk failure and consults the retry
   * strategy. Mid-stream errors propagate from the iterator and never
   * retry (chunks have already reached the consumer).
   */
  public requestStream(req: ProviderRequest): ProviderStreamResult {
    // Promise.withResolvers-style hand-roll: the executor runs synchronously
    // so the assignments below complete before the generator body runs.
    // Definite-assignment assertions document this for TS.
    let usageResolve!: (value: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    }) => void;
    let usageReject!: (reason: unknown) => void;
    const usage = new Promise<{
      readonly inputTokens: number;
      readonly outputTokens: number;
    }>((resolve, reject) => {
      usageResolve = resolve;
      usageReject = reject;
    });
    const self = this;
    const stream = (async function* openaiStream(): AsyncIterable<string> {
      if (self.apiKey === undefined || self.apiKey === "") {
        const err = new AuthError("OPENAI_API_KEY env var not set; cannot reach OpenAI.");
        usageReject(err);
        throw err;
      }
      for (const m of req.messages) {
        if (m.role === "system") {
          const err = new ProviderError(
            "OpenAI does not accept role 'system' inside ProviderRequest.messages here; pass system instructions via ProviderRequest.system instead.",
            "openai",
            undefined,
            false,
          );
          usageReject(err);
          throw err;
        }
      }
      let state: CachedSdkState;
      try {
        state = await self.ensureState();
      } catch (err) {
        usageReject(err);
        throw err;
      }
      const { errors: errs } = state;
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      const sdkRequest = {
        model: req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: buildSdkMessages(req.messages, req.attachments, req.system),
        stream: true as const,
        stream_options: { include_usage: true },
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      };

      let inputTokens = 0;
      let outputTokens = 0;
      try {
        // SDK-boundary cast: `chat.completions.create({ stream: true })`
        // returns an async iterable of ChatCompletionChunk.
        const sdkClient = state.client as {
          readonly chat: {
            readonly completions: {
              create(
                req: unknown,
                opts: { signal: AbortSignal },
              ): Promise<AsyncIterable<SdkChatCompletionChunk>>;
            };
          };
        };
        const sdkStream = await sdkClient.chat.completions.create(sdkRequest, {
          signal: ac.signal,
        });
        for await (const chunk of sdkStream) {
          // Usage-only final chunk (when `stream_options.include_usage` is
          // set) carries no choices and a populated usage object.
          if (chunk.usage !== undefined && chunk.usage !== null) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          }
          const deltaText = chunk.choices?.[0]?.delta?.content;
          if (typeof deltaText === "string" && deltaText.length > 0) {
            yield deltaText;
          }
        }
        usageResolve({ inputTokens, outputTokens });
      } catch (err) {
        const mapped = mapSdkError(err, errs, timeoutMs);
        usageReject(mapped);
        throw mapped;
      } finally {
        clearTimeout(timer);
      }
    })();
    return { stream, usage };
  }

  /**
   * Lazy-import the SDK and cache the client instance + error-class table
   * as a single atomic state object. Splitting this out of `request()`
   * keeps the request body focused on protocol translation; the
   * import-failure path (peer dep not installed) gets one place to surface
   * a friendly install hint. The atomic field write at the end ensures
   * concurrent callers either see no cached state (and re-enter
   * ensureState) or fully cached state (and proceed) - never a partial
   * mid-construction view.
   */
  private async ensureState(): Promise<CachedSdkState> {
    if (this.state !== undefined) return this.state;
    let mod: {
      default: new (opts: {
        apiKey: string;
        fetch?: typeof globalThis.fetch;
        maxRetries?: number;
      }) => unknown;
    } & SdkErrorClasses;
    try {
      mod = (await import("openai")) as unknown as typeof mod;
    } catch (err) {
      throw new ProviderError(
        "openai peer dependency is not installed. Run: npm install openai",
        "openai",
        err,
      );
    }
    const OpenAI = mod.default;
    if (this.apiKey === undefined) {
      throw new AuthError("OPENAI_API_KEY env var not set; cannot reach OpenAI.");
    }
    // The SDK's default maxRetries=2 would re-issue 5xx and 429 calls a
    // few times before surfacing the error. Limn owns retry policy at the
    // client layer (batch 1.3), so we disable the SDK's built-in retries
    // to avoid double-retries and keep error mapping deterministic. The
    // `fetch` override is forwarded conditionally so production code (no
    // override) continues to use the SDK's bundled fetch resolution.
    const client = new OpenAI({
      apiKey: this.apiKey,
      maxRetries: 0,
      ...(this.fetchOverride === undefined ? {} : { fetch: this.fetchOverride }),
    });
    // The SDK exposes the error classes as static properties on the
    // default export. We extract them once and store them in the same
    // state object as the client so the catch site does a plain
    // `instanceof` against cached references.
    const next: CachedSdkState = {
      client,
      errors: {
        APIError: mod.APIError,
        AuthenticationError: mod.AuthenticationError,
        PermissionDeniedError: mod.PermissionDeniedError,
        RateLimitError: mod.RateLimitError,
        InternalServerError: mod.InternalServerError,
        APIConnectionError: mod.APIConnectionError,
        APIConnectionTimeoutError: mod.APIConnectionTimeoutError,
        APIUserAbortError: mod.APIUserAbortError,
      },
    };
    // Single atomic field write: concurrent callers either see undefined
    // (and re-enter, which is idempotent) or this fully populated object.
    this.state = next;
    return next;
  }
}

/**
 * OpenAI image_url content part emitted on a `role: "user"` message when the
 * request carries attachments. The SDK accepts `content: string` (no
 * attachments) or `content: Array<{ type: "text"; text } | { type:
 * "image_url"; image_url: { url, detail? } }>` (mixed). The base64 source
 * variant ships today as a `data:<mime>;base64,<...>` data URI; remote URL
 * sources require widening `ImageSource` and live in a future batch.
 */
type OpenAIImageBlock = {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
};

type OpenAITextBlock = { readonly type: "text"; readonly text: string };

type OpenAIContent = string | ReadonlyArray<OpenAIImageBlock | OpenAITextBlock>;

/**
 * Build the `messages` array for the SDK call. Three things happen here:
 *
 * 1. If `system` was supplied, a `{ role: "system", content }` message is
 *    prepended to the array. OpenAI's chat completions API does not accept
 *    a top-level `system` field.
 * 2. Attachments (when supplied) attach to the FIRST `role: "user"` message
 *    in `messages` as a content array with image_url parts BEFORE the text
 *    part. OpenAI's vision documentation puts no firm ordering requirement
 *    on this, but mirroring Anthropic's "image first" placement keeps the
 *    two adapters' wire-level shapes parallel.
 * 3. Subsequent messages keep their plain-string `content` shape.
 *
 * Attachment placement runs against the input messages, then the system
 * message is prepended. So when both are supplied, the wire-level array
 * has the system message at index 0 and the (now-content-array) first user
 * message at index 1. The contract: attachments go on the first message
 * with `role: "user"` in the input messages, NOT on whichever message
 * happens to be at index 0 of the wire array.
 */
function buildSdkMessages(
  messages: readonly ChatMessage[],
  attachments: readonly Attachment[] | undefined,
  system: string | undefined,
): ReadonlyArray<{ readonly role: ChatMessage["role"]; readonly content: OpenAIContent }> {
  const translated: Array<{ readonly role: ChatMessage["role"]; readonly content: OpenAIContent }> =
    [];
  if (attachments === undefined || attachments.length === 0) {
    for (const m of messages) translated.push({ role: m.role, content: m.content });
  } else {
    let firstUserSeen = false;
    for (const m of messages) {
      if (m.role === "user" && !firstUserSeen) {
        firstUserSeen = true;
        const content: ReadonlyArray<OpenAIImageBlock | OpenAITextBlock> = [
          ...attachments.map(toOpenAIAttachmentBlock),
          { type: "text", text: m.content },
        ];
        translated.push({ role: m.role, content });
      } else {
        translated.push({ role: m.role, content: m.content });
      }
    }
  }
  if (system !== undefined) {
    return [{ role: "system", content: system }, ...translated];
  }
  return translated;
}

/**
 * Encode a `Uint8Array` (or `Buffer`, which extends it) to base64. `Buffer`'s
 * `toString("base64")` is Node-specific and does NOT exist on a raw
 * `Uint8Array`, so we route every byte payload through `Buffer.from(bytes)`
 * which accepts both. This keeps the `ImageSource.data` type widened to
 * `Uint8Array` (more portable, still type-compatible with any caller passing
 * a `Buffer`) without paying the cost of the slow
 * `btoa(String.fromCharCode(...bytes))` path; image attachments are a Node
 * feature today and the broader edge/browser portability story is tracked
 * separately.
 */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Translate one Limn `Attachment` to its OpenAI content-part shape. Pulled
 * out for testability and to keep `buildSdkMessages` focused on placement
 * (which message the parts attach to) rather than per-attachment shape
 * conversion.
 */
function toOpenAIAttachmentBlock(att: Attachment): OpenAIImageBlock {
  // Today the attachment union has one `kind` and the source union has one
  // `type`; the branches read as single arms. URL-based image sources
  // require widening `ImageSource` and are deliberately deferred. When
  // file/document attachments land in a future batch they get their own
  // arms and OpenAI's `file` content part.
  if (att.kind === "image") {
    return {
      type: "image_url",
      image_url: { url: `data:${att.source.mimeType};base64,${toBase64(att.source.data)}` },
    };
  }
  // The union is exhaustive today; this satisfies the never-check that
  // would surface if a future arm landed without a translation here.
  const _exhaustive: never = att.kind;
  throw new ProviderError(
    `Unsupported attachment kind: ${String(_exhaustive)}`,
    "openai",
    undefined,
    false,
  );
}

/**
 * Translate the SDK's `ChatCompletion` payload into Limn's
 * `ProviderResponse`. Pulled out of the class so it stays a pure function
 * (testable in isolation if we ever need to) and so the request method body
 * reads as the orchestration layer it is.
 *
 * OpenAI always returns at least one choice for a non-streaming completion;
 * we read `choices[0]` defensively anyway. A `null` content (the path
 * taken when the response carries `tool_calls` and no text) maps to an
 * empty string; tool calls themselves land in Phase 3.
 */
function mapSdkResponse(sdk: SdkChatCompletionResponse): ProviderResponse {
  const firstChoice = sdk.choices[0];
  const rawContent = firstChoice?.message.content;
  const content = typeof rawContent === "string" ? rawContent : "";
  return {
    content,
    toolCalls: [],
    stopReason: mapStopReason(firstChoice?.finish_reason ?? null),
    usage: {
      inputTokens: sdk.usage?.prompt_tokens ?? 0,
      outputTokens: sdk.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Map OpenAI's `finish_reason` enum onto Limn's narrower union. Unknown
 * future values fall through to "end" rather than throwing; an unfamiliar
 * stop reason should not cause a successful generation to look like a
 * failure. `content_filter` surfaces as `end` because the content field is
 * already empty/scrubbed by the time we see it; the caller observes a
 * normal end with empty content rather than a thrown error.
 */
function mapStopReason(sdk: SdkFinishReason | null): ProviderResponse["stopReason"] {
  switch (sdk) {
    case "stop":
    case "content_filter":
    case null:
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end";
  }
}

/**
 * Translate any throw out of the SDK into a Limn typed error. Order matters:
 * the more specific subclasses come first so `APIError` (the base) only
 * catches the long tail.
 *
 * The AbortController-driven timeout path surfaces as `APIUserAbortError`
 * (or `APIConnectionTimeoutError` if the SDK detects the abort before its
 * own internal timeout fires) in the real SDK; we map both to
 * `ModelTimeoutError` because the user's mental model is "the call timed
 * out", not "I aborted my own call". (Real abort support — a user-supplied
 * AbortSignal — lands in batch 1.8.)
 */
function mapSdkError(err: unknown, errs: SdkErrorClasses, timeoutMs: number): Error {
  if (err instanceof errs.AuthenticationError || err instanceof errs.PermissionDeniedError) {
    return new AuthError(`OpenAI auth failed: ${(err as Error).message}`, err);
  }
  if (err instanceof errs.RateLimitError) {
    const headers = (err as SdkRateLimitErrorLike).headers;
    const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
    const seconds = raw === undefined ? Number.NaN : Number(raw);
    const retryAfterMs =
      Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
    return new RateLimitError(`OpenAI rate limit: ${(err as Error).message}`, retryAfterMs, err);
  }
  if (err instanceof errs.APIConnectionTimeoutError || err instanceof errs.APIUserAbortError) {
    return new ModelTimeoutError(`OpenAI timed out after ${timeoutMs}ms`, timeoutMs, err);
  }
  if (err instanceof errs.InternalServerError || err instanceof errs.APIConnectionError) {
    return new ProviderError(`OpenAI transport error: ${(err as Error).message}`, "openai", err);
  }
  // Bare APIError catch-all. The OpenAI SDK declares status-specific
  // subclasses for 400 (BadRequestError), 404 (NotFoundError), 409
  // (ConflictError), and 422 (UnprocessableEntityError) that this branch
  // intentionally swallows: they all surface as a single ProviderError
  // with `retryable: false` because 4xx client faults are deterministic;
  // re-issuing the same request will fail the same way. Callers who need
  // finer disambiguation can still inspect `err.cause` to find the
  // underlying SDK class. Transient 5xx faults are handled above by the
  // InternalServerError / APIConnectionError branch, which keeps the
  // default `retryable: true`.
  if (err instanceof errs.APIError) {
    return new ProviderError(`OpenAI API error: ${(err as Error).message}`, "openai", err, false);
  }
  // Truly unexpected throws (not subclasses of APIError) are deterministic
  // by assumption: the SDK invariant we relied on broke, and re-issuing
  // the same call will hit the same broken assumption. Mark non-retryable.
  return new ProviderError(
    `Unexpected OpenAI error: ${err instanceof Error ? err.message : String(err)}`,
    "openai",
    err,
    false,
  );
}
