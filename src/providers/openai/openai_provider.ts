/**
 * OpenAI provider adapter. Wraps `openai`. Symmetric with the Anthropic
 * adapter; Phase 1 placeholder until the implementation lands.
 */

import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "../provider.js";

export class OpenAIProvider implements Provider {
  public readonly name = "openai" as const;

  public async request(_req: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("OpenAIProvider.request is not implemented yet (Phase 1).");
  }

  // eslint-disable-next-line require-yield
  public async *stream(_req: ProviderRequest): AsyncIterable<string> {
    throw new Error("OpenAIProvider.stream is not implemented yet (Phase 1).");
  }
}
