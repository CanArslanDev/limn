/**
 * Maps a `ModelName` to the provider that owns it. New providers register
 * here; the client looks up at request time so user code only ever names a
 * model, never picks a provider.
 *
 * Lazy bootstrap (batch 1.2): when `getProvider(name)` is called without a
 * prior `registerProvider(name, ...)`, the registry tries to construct the
 * default adapter for that vendor on the fly using the relevant
 * `<VENDOR>_API_KEY` env var. This is what makes `await ai.ask("...")` Just
 * Work in user code that never thinks about providers. Tests bypass the
 * bootstrap by registering a `MockProvider` first; the cached entry then
 * short-circuits the bootstrap path.
 */

import { AuthError } from "../errors/index.js";
import { AnthropicProvider } from "./anthropic/anthropic_provider.js";
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

/**
 * Resolve a provider by name. If nothing was registered, attempt to construct
 * the default vendor adapter from the relevant env var. If neither path
 * yields a provider, throw `AuthError` with a message naming the env var the
 * caller must set.
 *
 * AuthError (not generic Error) because "missing API key" is precisely the
 * recovery path the AuthError docstring describes ("surface to the user;
 * waiting does not fix it"). Tests can `instanceof AuthError` to assert this
 * without string-matching.
 */
export function getProvider(name: ProviderName): Provider {
  const cached = _providers.get(name);
  if (cached !== undefined) return cached;

  const bootstrapped = bootstrap(name);
  if (bootstrapped !== null) {
    _providers.set(name, bootstrapped);
    return bootstrapped;
  }
  throw new AuthError(
    `Provider "${name}" requires an API key. Set ${envVarFor(name)} or call registerProvider("${name}", providerInstance) explicitly.`,
  );
}

/**
 * Construct the default adapter for `name` if its env-var key is present.
 * Returns null when no key is set so `getProvider` can throw a clear
 * AuthError (rather than letting the adapter construction throw a less
 * actionable one). New vendors add a switch arm here as their adapter lands.
 */
function bootstrap(name: ProviderName): Provider | null {
  switch (name) {
    case "anthropic": {
      // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket notation under TS noPropertyAccessFromIndexSignature
      const key = process.env["ANTHROPIC_API_KEY"];
      if (key === undefined || key === "") return null;
      return new AnthropicProvider({ apiKey: key });
    }
    case "openai":
      // OpenAI adapter lands in batch 1.6. Until then, bootstrap returns null
      // so getProvider throws AuthError naming OPENAI_API_KEY (better UX than
      // an unrelated "not implemented" message).
      return null;
  }
}

/** Env var name that holds the API key for the given provider. */
function envVarFor(name: ProviderName): string {
  switch (name) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
  }
}

/**
 * Remove a registered provider, restoring the "not registered" state for that
 * name. Used primarily by tests to keep the module-scoped registry isolated
 * between test runs (and between test files in the same Vitest worker). A
 * call to `getProvider(name)` after `unregisterProvider(name)` re-runs the
 * lazy-bootstrap path; if the relevant env var is set the registry will mint
 * a fresh adapter, otherwise it throws the same AuthError a fresh process
 * would.
 */
export function unregisterProvider(name: ProviderName): void {
  _providers.delete(name);
}
