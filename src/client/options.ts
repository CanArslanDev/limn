/**
 * User-facing option shapes for Layer 1 calls. Every option is documented
 * inline so editor tooltips show the rationale without consulting the docs.
 */

import type { ModelName } from "../providers/model_name.js";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface BaseCallOptions {
  /** Override the default model. Falls through to `LimnConfig.defaultModel`. */
  readonly model?: ModelName;
  /** Per-call retry override. Falls through to `LimnConfig.retry.maxAttempts`. */
  readonly maxRetries?: number;
  /** Per-call timeout. Falls through to `LimnConfig.timeoutMs`. */
  readonly timeoutMs?: number;
  /** Per-call sampling temperature; provider clamps to its supported range. */
  readonly temperature?: number;
  /** Cap on output tokens; provider clamps to its supported range. */
  readonly maxTokens?: number;
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
