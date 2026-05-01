/**
 * Anthropic provider adapter. Wraps `@anthropic-ai/sdk`'s messages API.
 *
 * The SDK is a peer dependency. Consumers who use only OpenAI never need it
 * installed; we lazy-import via `await import("@anthropic-ai/sdk")` on first
 * request to avoid pulling Anthropic into bundles that do not need it.
 *
 * Error mapping (from the SDK's APIError subclasses + transport errors):
 * - 401 / 403 -> AuthError (do not retry; the key is bad)
 * - 429 -> RateLimitError(retryAfterMs from `Retry-After` header)
 * - 5xx + network errors -> ProviderError("anthropic", cause)
 * - APIUserAbortError + APIConnectionTimeoutError -> ModelTimeoutError(timeoutMs, cause)
 *
 * Construction reads `ANTHROPIC_API_KEY` from process.env when no explicit
 * key is supplied. If the key is missing, request() throws AuthError on
 * first invocation rather than at construction time; this lets test code
 * construct + register a provider without a real key.
 *
 * The constructor accepts `AnthropicProviderOptions` instead of positional
 * arguments so future fields (custom baseURL, custom fetch implementation,
 * default headers) can land without changing call sites. The `fetch` option
 * forwards to the SDK's documented `fetch` constructor option, primarily
 * used by tests to replay JSON fixtures from `test/fixtures/anthropic/`.
 *
 * Provider boundary note: this file is the documented SDK-boundary cast site
 * for the Anthropic SDK. The SDK's `messages.create()` overloads return a
 * stream-or-message union that TypeScript narrows poorly through dynamic
 * import, so we cast the cached client to the precise structural shape of the
 * one method we call and re-narrow the response with `SdkMessageResponse`
 * immediately. The cast stays a tight, named structural type rather than
 * `any` so a future SDK signature change surfaces as a type error here
 * instead of silently propagating. Everywhere outside this file remains
 * `unknown`/sealed.
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
 * Constructor options for {@link AnthropicProvider}. Options-object shape
 * (rather than positional arguments) lets future additions land without
 * breaking call sites.
 */
export interface AnthropicProviderOptions {
  /**
   * Anthropic API key. Defaults to `process.env.ANTHROPIC_API_KEY` when the
   * `apiKey` field is omitted entirely. Passing the field explicitly with
   * `undefined` bypasses the env-var fallback; this is useful when tests
   * want to assert the missing-key behavior on a developer machine that
   * has `ANTHROPIC_API_KEY` set in its shell. The constructor uses an
   * `"apiKey" in options` check (not `??`) to distinguish the two paths.
   */
  readonly apiKey?: string | undefined;
  /**
   * Optional `fetch` implementation forwarded to the underlying SDK. The
   * SDK's `ClientOptions.fetch` is documented as
   * `(url: RequestInfo, init?: RequestInit) => Promise<Response>`, which
   * the standard `fetch` satisfies. Test code injects a fake `fetch` that
   * replays recorded fixtures from `test/fixtures/anthropic/`; production
   * code omits this and the SDK uses the global `fetch`.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Subset of the Anthropic SDK's `Message` shape that the adapter consumes.
 * The full SDK type is much larger; we narrow to just the fields we map so
 * a future SDK addition cannot silently change behavior.
 */
interface SdkMessageResponse {
  readonly content: ReadonlyArray<SdkContentBlock>;
  readonly stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

type SdkContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: string; readonly [key: string]: unknown };

/**
 * Structural narrowing of the Anthropic SDK's `RawMessageStreamEvent` union
 * that the streaming adapter consumes. The full SDK union covers six event
 * kinds; we only act on three (`message_start` for input tokens,
 * `content_block_delta` for text deltas, `message_delta` for output-token
 * progress) and ignore the rest. Each branch reads through optional fields
 * so a future SDK reorganization (e.g. moving `usage` into a sibling event)
 * surfaces as a runtime no-op rather than a crash.
 */
interface SdkStreamEvent {
  readonly type: string;
  readonly message?: {
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  };
  readonly delta?: { readonly type?: string; readonly text?: string };
  readonly usage?: { readonly output_tokens?: number };
}

/**
 * Subset of the SDK error-class surface the adapter touches. The SDK exposes
 * each class as a static property on the default export AND as a named export;
 * we use the static-property form so the import surface is one symbol.
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
 * Loosened RateLimitError shape used at the catch site. The SDK's RateLimitError
 * carries a `headers` bag that may or may not include `retry-after`; we read it
 * defensively because header capitalization varies across runtimes.
 */
interface SdkRateLimitErrorLike extends Error {
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Read `ANTHROPIC_API_KEY` from `process.env`. Pulled into a helper so the
 * one place that needs the bracket-notation lint suppression (TS forbids
 * dot-access on the index-signature `process.env` under
 * `noPropertyAccessFromIndexSignature`, but Biome's `useLiteralKeys` rule
 * wants dot access) lives in one spot rather than at every call site.
 */
function readApiKeyFromEnv(): string | undefined {
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket notation under TS noPropertyAccessFromIndexSignature
  return process.env["ANTHROPIC_API_KEY"];
}

/**
 * Cached SDK state: the constructed client plus the error-class table. Both
 * are populated together by `ensureClient()` and assigned as one atomic field
 * write so a concurrent caller sees either "nothing cached" (and waits its
 * turn) or "fully cached" (and proceeds). Splitting them into two independent
 * mutable fields would invite a "client cached but errors not yet" window
 * during interleaved `request()` calls.
 */
interface CachedSdkState {
  readonly client: unknown;
  readonly errors: SdkErrorClasses;
}

export class AnthropicProvider implements Provider {
  public readonly name = "anthropic" as const;

  // Lazy-cached SDK state. First request() call populates it; subsequent
  // calls reuse. The two halves (client + error-class table) live in one
  // object so they are observed together; see CachedSdkState's JSDoc.
  private state: CachedSdkState | undefined;

  private readonly apiKey: string | undefined;
  private readonly fetchOverride: typeof globalThis.fetch | undefined;

  /**
   * Construct a provider. Without arguments the constructor reads
   * `ANTHROPIC_API_KEY` from `process.env` and uses the global `fetch`.
   * Tests pass `{ apiKey: "test-key", fetch: fakeFetch }` so they need not
   * mutate the process environment and can replay JSON fixtures without
   * touching the network. The `apiKey` field is `keyof`-present in
   * options even when `undefined`; supplying `{ apiKey: undefined }`
   * explicitly skips the env-var fallback (useful for asserting the
   * missing-key behavior on developer machines that have the var set).
   */
  public constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = "apiKey" in options ? options.apiKey : readApiKeyFromEnv();
    this.fetchOverride = options.fetch;
  }

  /**
   * Translate a Traceworks `ProviderRequest` into an Anthropic SDK call, then map
   * the SDK's response (or thrown error) into the Traceworks shapes the rest of
   * the library consumes.
   *
   * Anthropic's messages array does not accept `role: "system"`; system
   * instructions belong in the top-level `system` field. The `ai.ask` wiring
   * already routes user-supplied system instructions to `req.system`. If a
   * `role: "system"` message slips into `messages` (e.g. a direct adapter
   * caller), we throw a `ProviderError` with a fix-it message instead of
   * silently coercing it; silent coercion would mask user bugs in `ai.chat`
   * once that lands.
   */
  public async request(req: ProviderRequest): Promise<ProviderResponse> {
    // Auth check before any SDK touch. Two reasons:
    //   1. Faster failure for the common "forgot to set the key" mistake.
    //   2. Avoids importing the SDK module just to immediately throw.
    if (this.apiKey === undefined || this.apiKey === "") {
      throw new AuthError("ANTHROPIC_API_KEY env var not set; cannot reach Anthropic.");
    }

    // Defensive guard for direct adapter callers. See JSDoc above. Marked
    // `retryable: false` because this is a caller bug (wrong message shape),
    // not a transient fault: re-issuing the same request will fail the same
    // way. The retry strategy honors the flag and rethrows immediately.
    for (const m of req.messages) {
      if (m.role === "system") {
        throw new ProviderError(
          "Anthropic does not accept role 'system' in the messages array; pass it via ProviderRequest.system instead.",
          "anthropic",
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
      messages: buildSdkMessages(req.messages, req.attachments),
      ...(req.system === undefined ? {} : { system: req.system }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    };

    try {
      // SDK-boundary cast. The SDK's overloaded `create()` routes through a
      // stream/non-stream union that does not narrow cleanly out of dynamic
      // import. We cast the cached `unknown` client to the precise structural
      // shape of the one method we use; the response is typed as
      // SdkMessageResponse on the same line. No `any` escapes this site.
      const sdkClient = state.client as {
        readonly messages: {
          create(req: unknown, opts: { signal: AbortSignal }): Promise<SdkMessageResponse>;
        };
      };
      const sdkResponse = await sdkClient.messages.create(sdkRequest, {
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
   * Begin a streaming request against Anthropic's `messages.create({ stream:
   * true })` endpoint. Returns the two-channel result from the Provider
   * contract: `stream` is the iterator of textual deltas, `usage` is the
   * promise that resolves once the stream drains with cumulative tokens.
   *
   * Anthropic's stream emits a typed event union; we filter to
   * `content_block_delta` events whose delta is a `text_delta` and yield
   * the text. `message_start` carries the input-token count; `message_delta`
   * carries the cumulative output-token count. We stash both as we see them
   * and resolve the usage promise at end-of-stream.
   *
   * Error mapping mirrors `request()`: SDK-level errors translate through
   * `mapSdkError`. A pre-stream failure (auth, missing peer dep) surfaces
   * by making the iterator's first `next()` throw; the dispatcher's stream
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
    const stream = (async function* anthropicStream(): AsyncIterable<string> {
      // Auth check before any SDK touch (mirrors request()'s ordering).
      if (self.apiKey === undefined || self.apiKey === "") {
        const err = new AuthError("ANTHROPIC_API_KEY env var not set; cannot reach Anthropic.");
        usageReject(err);
        throw err;
      }
      for (const m of req.messages) {
        if (m.role === "system") {
          const err = new ProviderError(
            "Anthropic does not accept role 'system' in the messages array; pass it via ProviderRequest.system instead.",
            "anthropic",
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
        messages: buildSdkMessages(req.messages, req.attachments),
        stream: true as const,
        ...(req.system === undefined ? {} : { system: req.system }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      };

      let inputTokens = 0;
      let outputTokens = 0;
      try {
        // SDK-boundary cast: `messages.create({ stream: true })` returns an
        // async iterable of typed events. We narrow to the structural shape
        // we consume; the per-event union is read defensively below.
        const sdkClient = state.client as {
          readonly messages: {
            create(
              req: unknown,
              opts: { signal: AbortSignal },
            ): Promise<AsyncIterable<SdkStreamEvent>>;
          };
        };
        const sdkStream = await sdkClient.messages.create(sdkRequest, { signal: ac.signal });
        for await (const event of sdkStream) {
          if (event.type === "message_start") {
            const startUsage = event.message?.usage;
            if (startUsage !== undefined) {
              inputTokens = startUsage.input_tokens ?? inputTokens;
              outputTokens = startUsage.output_tokens ?? outputTokens;
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              yield delta.text;
            }
          } else if (event.type === "message_delta") {
            const deltaUsage = event.usage;
            if (deltaUsage !== undefined) {
              outputTokens = deltaUsage.output_tokens ?? outputTokens;
            }
          }
          // Other event types (content_block_start, content_block_stop,
          // message_stop) are intentionally ignored; they carry no data we
          // surface today.
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
   * Lazy-import the SDK and cache the client instance + error-class table as
   * a single atomic state object. Splitting this out of `request()` keeps the
   * request body focused on protocol translation; the import-failure path
   * (peer dep not installed) gets one place to surface a friendly install
   * hint. The atomic field write at the end ensures concurrent callers
   * either see no cached state (and re-enter ensureState) or fully cached
   * state (and proceed) - never a partial mid-construction view.
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
      mod = (await import("@anthropic-ai/sdk")) as unknown as typeof mod;
    } catch (err) {
      throw new ProviderError(
        "@anthropic-ai/sdk peer dependency is not installed. Run: npm install @anthropic-ai/sdk",
        "anthropic",
        err,
      );
    }
    const Anthropic = mod.default;
    // Non-null assertion would also work here; explicit narrowing is clearer.
    if (this.apiKey === undefined) {
      throw new AuthError("ANTHROPIC_API_KEY env var not set; cannot reach Anthropic.");
    }
    // The SDK's default maxRetries=2 would re-issue 5xx and 429 calls a few
    // times before surfacing the error. Traceworks owns retry policy at the client
    // layer (batch 1.4), so we disable the SDK's built-in retries to avoid
    // double-retries and keep error mapping deterministic. The `fetch`
    // override is forwarded conditionally so production code (no override)
    // continues to use the SDK's bundled fetch resolution.
    const client = new Anthropic({
      apiKey: this.apiKey,
      maxRetries: 0,
      ...(this.fetchOverride === undefined ? {} : { fetch: this.fetchOverride }),
    });
    // The SDK exposes the error classes as static properties on the default
    // export. We extract them once and store them in the same state object
    // as the client so the catch site does a plain `instanceof` against
    // cached references.
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
 * Anthropic content block emitted on a `role: "user"` message when the request
 * carries attachments. The SDK (pinned floor `@anthropic-ai/sdk@0.30.x`)
 * accepts `content: string` (no attachments) or
 * `content: Array<{ type: "text"; text } | { type: "image"; source }>`
 * (mixed). The base64 source variant is the only one shipped today; URL
 * sources require a newer SDK floor.
 */
type AnthropicImageBlock = {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly media_type: string;
    readonly data: string;
  };
};

type AnthropicTextBlock = { readonly type: "text"; readonly text: string };

type AnthropicContent = string | ReadonlyArray<AnthropicImageBlock | AnthropicTextBlock>;

/**
 * Build the `messages` array for the SDK call. Attachments (when supplied)
 * attach to the first `role: "user"` message as a content array with image
 * blocks BEFORE the text block; Anthropic's vision documentation recommends
 * leading with images so the model attends to them first. Subsequent
 * messages keep their plain-string `content` shape (back-compat with the
 * existing fixture-based assertions in `anthropic_provider.test.ts`).
 *
 * If no attachments are supplied, every message stays a plain
 * `{ role, content: string }` pair, identical to the pre-batch-1.5 shape.
 */
function buildSdkMessages(
  messages: readonly ChatMessage[],
  attachments: readonly Attachment[] | undefined,
): ReadonlyArray<{ readonly role: ChatMessage["role"]; readonly content: AnthropicContent }> {
  if (attachments === undefined || attachments.length === 0) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }
  let firstUserSeen = false;
  return messages.map((m) => {
    if (m.role === "user" && !firstUserSeen) {
      firstUserSeen = true;
      const content: ReadonlyArray<AnthropicImageBlock | AnthropicTextBlock> = [
        ...attachments.map(toAnthropicAttachmentBlock),
        { type: "text", text: m.content },
      ];
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });
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
 * Translate one Traceworks `Attachment` to its Anthropic content-block shape.
 * Pulled out for testability and to keep `buildSdkMessages` focused on
 * placement (which message the blocks attach to) rather than per-attachment
 * shape conversion.
 */
function toAnthropicAttachmentBlock(att: Attachment): AnthropicImageBlock {
  // Today the attachment union has one `kind` and the source union has one
  // `type`; the branches read as single arms. URL-based image sources
  // require a newer SDK than our pinned floor and are deliberately deferred.
  // When file/document attachments land in a future batch they get their
  // own arms and Anthropic's `document` content block.
  if (att.kind === "image") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: att.source.mimeType,
        data: toBase64(att.source.data),
      },
    };
  }
  // The union is exhaustive today; this satisfies the never-check that
  // would surface if a future arm landed without a translation here.
  const _exhaustive: never = att.kind;
  throw new ProviderError(
    `Unsupported attachment kind: ${String(_exhaustive)}`,
    "anthropic",
    undefined,
    false,
  );
}

/**
 * Translate the SDK's `Message` payload into Traceworks's `ProviderResponse`. Pulled
 * out of the class so it stays a pure function (testable in isolation if we
 * ever need to) and so the request method body reads as the orchestration
 * layer it is.
 */
function mapSdkResponse(sdk: SdkMessageResponse): ProviderResponse {
  const content = sdk.content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");

  return {
    content,
    toolCalls: [],
    stopReason: mapStopReason(sdk.stop_reason),
    usage: {
      inputTokens: sdk.usage.input_tokens,
      outputTokens: sdk.usage.output_tokens,
    },
  };
}

/**
 * Map Anthropic's `stop_reason` enum onto Traceworks's narrower union. Unknown
 * future values fall through to "end" rather than throwing; an unfamiliar
 * stop reason should not cause a successful generation to look like a failure.
 */
function mapStopReason(sdk: SdkMessageResponse["stop_reason"]): ProviderResponse["stopReason"] {
  switch (sdk) {
    case "end_turn":
    case "stop_sequence":
    case null:
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "end";
  }
}

/**
 * Translate any throw out of the SDK into a Traceworks typed error. Order matters:
 * the more specific subclasses come first so `APIError` (the base) only
 * catches the long tail.
 *
 * The AbortController-driven timeout path surfaces as `APIUserAbortError` in
 * the real SDK; we map it to `ModelTimeoutError` because the user's mental
 * model is "the call timed out", not "I aborted my own call". (Real abort
 * support — a user-supplied AbortSignal — lands in batch 1.8.)
 */
function mapSdkError(err: unknown, errs: SdkErrorClasses, timeoutMs: number): Error {
  if (err instanceof errs.AuthenticationError || err instanceof errs.PermissionDeniedError) {
    return new AuthError(`Anthropic auth failed: ${(err as Error).message}`, err);
  }
  if (err instanceof errs.RateLimitError) {
    const headers = (err as SdkRateLimitErrorLike).headers;
    const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
    const seconds = raw === undefined ? Number.NaN : Number(raw);
    const retryAfterMs =
      Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
    return new RateLimitError(`Anthropic rate limit: ${(err as Error).message}`, retryAfterMs, err);
  }
  if (err instanceof errs.APIConnectionTimeoutError || err instanceof errs.APIUserAbortError) {
    return new ModelTimeoutError(`Anthropic timed out after ${timeoutMs}ms`, timeoutMs, err);
  }
  if (err instanceof errs.InternalServerError || err instanceof errs.APIConnectionError) {
    return new ProviderError(
      `Anthropic transport error: ${(err as Error).message}`,
      "anthropic",
      err,
    );
  }
  // Bare APIError catch-all. The Anthropic SDK declares status-specific
  // subclasses for 400 (BadRequestError), 404 (NotFoundError), 409
  // (ConflictError), and 422 (UnprocessableEntityError) that this branch
  // intentionally swallows: they all surface as a single ProviderError with
  // `retryable: false` because 4xx client faults are deterministic; re-issuing
  // the same request will fail the same way. Callers who need finer
  // disambiguation can still inspect `err.cause` to find the underlying SDK
  // class. Transient 5xx faults are handled above by the InternalServerError /
  // APIConnectionError branch, which keeps the default `retryable: true`.
  if (err instanceof errs.APIError) {
    return new ProviderError(
      `Anthropic API error: ${(err as Error).message}`,
      "anthropic",
      err,
      false,
    );
  }
  // Truly unexpected throws (not subclasses of APIError) are deterministic by
  // assumption: the SDK invariant we relied on broke, and re-issuing the same
  // call will hit the same broken assumption. Mark non-retryable.
  return new ProviderError(
    `Unexpected Anthropic error: ${err instanceof Error ? err.message : String(err)}`,
    "anthropic",
    err,
    false,
  );
}
