/**
 * Maps a `ModelName` to the provider that owns it. New providers register
 * here; the client looks up at request time so user code only ever names a
 * model, never picks a provider.
 */

import { ANTHROPIC_MODELS, type ModelName, OPENAI_MODELS } from "./model_name.js";
import type { Provider } from "./provider.js";

export type ProviderName = "anthropic" | "openai";

export function providerFor(model: ModelName): ProviderName {
  if ((ANTHROPIC_MODELS as readonly string[]).includes(model)) {
    return "anthropic";
  }
  if ((OPENAI_MODELS as readonly string[]).includes(model)) {
    return "openai";
  }
  throw new Error(`Unknown model: ${model}. Add it to model_name.ts.`);
}

const _providers = new Map<ProviderName, Provider>();

export function registerProvider(name: ProviderName, provider: Provider): void {
  _providers.set(name, provider);
}

export function getProvider(name: ProviderName): Provider {
  const p = _providers.get(name);
  if (!p) {
    throw new Error(`Provider "${name}" not registered. Did you set the API key for it?`);
  }
  return p;
}
