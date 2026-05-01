/**
 * User-facing option shapes for Layer 1 calls. Every option is documented
 * inline so editor tooltips show the rationale without consulting the docs.
 */

import type { ModelName } from "../providers/model_name.js";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * MIME types Anthropic accepts for image attachments. Encoded as a string
 * literal union so a typo at the call site (`"image/heic"`, `"image/svg+xml"`)
 * surfaces as a compile-time error rather than a runtime SDK rejection. When
 * additional providers gain vision support (OpenAI batch 1.6) and disagree on
 * the supported set, we narrow per-provider via a separate type or widen the
 * union and validate per-adapter.
 */
export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * How an image attachment's bytes reach the provider. One variant today:
 *
 * - `base64`: the user supplies raw bytes as a `Uint8Array` (Node's `Buffer`
 *   extends `Uint8Array`, so a `Buffer` from `await fs.readFile(...)` works
 *   directly). Traceworks handles base64 encoding inside the adapter; the brief
 *   explicitly forbids manual encoding at the call site.
 *
 * URL-based image sources require an SDK version that is not yet in our
 * peer-dep floor (`@anthropic-ai/sdk@0.30.x`). When the floor moves, the URL
 * variant will be added back as a non-breaking type widening.
 */
export type ImageSource = {
  readonly type: "base64";
  readonly data: Uint8Array;
  readonly mimeType: SupportedImageMimeType;
};

/**
 * Image attachment block. Today's only `Attachment` variant; the discriminator
 * (`kind`) leaves room for `file` / `document` etc. without breaking changes.
 */
export interface ImageAttachment {
  readonly kind: "image";
  readonly source: ImageSource;
}

/**
 * Sealed union of attachment shapes accepted on `AskOptions` /
 * `ChatOptions` / `ExtractOptions` / `StreamOptions`. The adapter routes each
 * variant to the provider's content-block API. As of batch 1.5 only
 * `ImageAttachment` is supported; future batches will add file and document
 * variants under additional `kind` discriminators.
 */
export type Attachment = ImageAttachment;

interface BaseCallOptions {
  /** Override the default model. Falls through to `TraceworksConfig.defaultModel`. */
  readonly model?: ModelName;
  /** Per-call retry override. Falls through to `TraceworksConfig.retry.maxAttempts`. */
  readonly maxRetries?: number;
  /** Per-call timeout. Falls through to `TraceworksConfig.timeoutMs`. */
  readonly timeoutMs?: number;
  /** Per-call sampling temperature; provider clamps to its supported range. */
  readonly temperature?: number;
  /** Cap on output tokens; provider clamps to its supported range. */
  readonly maxTokens?: number;
  /**
   * Attachments (images today; file/document variants land in later batches)
   * sent with this call. The adapter routes them to the provider's vision /
   * content-block API in a provider-specific shape; the user supplies raw
   * `Uint8Array`s (a Node `Buffer` works because `Buffer extends Uint8Array`)
   * and never encodes anything by hand.
   */
  readonly attachments?: readonly Attachment[];
  /**
   * Per-call API key override. Takes precedence over the environment
   * variable and any provider previously registered via
   * `registerProvider(...)`. The client constructs a fresh adapter for
   * THIS call only (the registry's cached provider is untouched), so the
   * key never leaks into adjacent calls or future calls. The trace
   * pipeline never persists the key (the redactor scrubs `sk-ant-` /
   * `sk-proj-` / `sk-` substrings from the request and response).
   *
   * The canonical use case is multi-tenant deployment where each request
   * authenticates as a different end-user; passing the per-tenant key on
   * the call rather than mutating the registry keeps tenants isolated.
   */
  readonly apiKey?: string;
}

export interface AskOptions extends BaseCallOptions {
  /** Optional system instruction prepended to the prompt. */
  readonly system?: string;
}

export interface ChatOptions extends BaseCallOptions {
  /** Optional system instruction; if a `role: "system"` message is present in
   *  the array, that one wins. */
  readonly system?: string;
}

export interface ExtractOptions extends BaseCallOptions {
  /** When true, retry once with the validation error fed back to the model. */
  readonly retryOnSchemaFailure?: boolean;
}

export interface StreamOptions extends BaseCallOptions {
  /** Called once per token (or chunk) for sinks that prefer callbacks over
   *  iteration. Both modes are supported simultaneously. */
  readonly onChunk?: (chunk: string) => void;
}
