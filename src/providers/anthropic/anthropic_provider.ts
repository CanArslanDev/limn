/**
 * Anthropic provider adapter. Wraps `@anthropic-ai/sdk`. The SDK is a peer
 * dependency, so this file dynamically imports it on first use to keep
 * bundlers from pulling Anthropic into builds that only use OpenAI.
 *
 * Phase 1 placeholder: throws on use until the implementation lands.
 */

import type { Provider, ProviderRequest, ProviderResponse } from "../provider.js";

export class AnthropicProvider implements Provider {
  public readonly name = "anthropic" as const;

  public async request(_req: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("AnthropicProvider.request is not implemented yet (Phase 1).");
  }

  public stream(_req: ProviderRequest): AsyncIterable<string> {
    throw new Error("AnthropicProvider.stream is not implemented yet (Phase 1).");
  }
}
