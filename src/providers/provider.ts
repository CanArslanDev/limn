/**
 * Internal provider contract. Every concrete provider (Anthropic, OpenAI, ...)
 * implements this interface. User code never imports this directly; it stays
 * behind `src/client/` so we can swap or extend providers without touching
 * the public surface.
 */

import type { Attachment, ChatMessage } from "../client/options.js";
import type { ModelName } from "./model_name.js";

export interface ProviderRequest {
  readonly model: ModelName;
  readonly messages: readonly ChatMessage[];
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly tools?: readonly ProviderToolSpec[];
  /**
   * Attachments to send with this request. The adapter is responsible for
   * injecting them as content blocks on the FIRST `role: "user"` message in
   * `messages`; this keeps `ChatMessage.content: string` unchanged across the
   * codebase while concentrating per-vendor translation in one place. Order
   * within the array is preserved when emitted as content blocks.
   */
  readonly attachments?: readonly Attachment[];
}

export interface ProviderToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ProviderResponse {
  readonly content: string;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly stopReason: "end" | "tool_use" | "max_tokens" | "timeout";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * Two-channel result returned by `Provider.requestStream`. The `stream` is the
 * caller-iterable channel (one string per textual delta from the provider);
 * `usage` resolves once the stream has fully drained, carrying the cumulative
 * token counts the provider reports at end-of-stream.
 *
 * Why two channels rather than embedding usage in the iterator: the iterator
 * is typed `AsyncIterable<string>` so the consumer's `for await` loop yields
 * raw chunks. Squeezing a `{ done, usage }` sentinel into the same channel
 * would force `AsyncIterable<{ chunk } | { done }>` and push the union into
 * every consumer. The promise channel keeps the chunk type pristine and
 * gives the dispatcher a clean handle to await for trace recording.
 *
 * Contract: `usage` MUST resolve (or reject) after the iterator either
 * completes or throws. Adapters set the promise from the SDK's final event;
 * the `MockProvider` resolves it from the scripted usage object.
 */
export interface ProviderStreamResult {
  readonly stream: AsyncIterable<string>;
  readonly usage: Promise<{ readonly inputTokens: number; readonly outputTokens: number }>;
}

export interface Provider {
  readonly name: string;
  request(req: ProviderRequest): Promise<ProviderResponse>;
  /**
   * Begin a streaming request. Returns the iterable chunk channel plus a
   * usage promise that resolves at end-of-stream. Adapters translate
   * SDK-level errors into `LimnError` subclasses just like `request()`. The
   * iterator's first `next()` is the latest point at which a "first-chunk"
   * error can surface; the dispatcher's stream loop treats first-chunk
   * errors as retryable per the configured strategy.
   */
  requestStream(req: ProviderRequest): ProviderStreamResult;
}
