/**
 * Internal provider contract. Every concrete provider (Anthropic, OpenAI, ...)
 * implements this interface. User code never imports this directly; it stays
 * behind `src/client/` so we can swap or extend providers without touching
 * the public surface.
 */

import type { ChatMessage } from "../client/options.js";
import type { ModelName } from "./model_name.js";

export interface ProviderRequest {
  readonly model: ModelName;
  readonly messages: readonly ChatMessage[];
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly tools?: readonly ProviderToolSpec[];
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

export interface Provider {
  readonly name: string;
  request(req: ProviderRequest): Promise<ProviderResponse>;
  stream(req: ProviderRequest): AsyncIterable<string>;
}
