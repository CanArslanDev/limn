/**
 * Identity helper for `limn.config.ts`. Lets users get full IntelliSense on
 * their config without having to import and annotate the type:
 *
 *   import { defineConfig } from "limn";
 *   export default defineConfig({ defaultModel: "claude-sonnet-4-6" });
 */

import type { ModelName } from "../providers/model_name.js";
import type { RetryConfig, TraceConfig } from "./limn_config.js";

/**
 * User-facing config shape: every field is optional AND nested groups
 * (`retry`, `trace`) accept partials so callers can override a single
 * nested field without re-supplying its siblings. The barrel re-exports
 * this from the package root so consumers can annotate their `.ts` config
 * directly when they prefer it over `defineConfig`'s inference.
 *
 * Defined explicitly (rather than via `Partial<LimnConfig>`) because a
 * straight `Partial` only makes the top-level fields optional; the nested
 * `retry`/`trace` groups would still demand every sub-field. The explicit
 * shape lets `defineConfig({ retry: { maxAttempts: 5 } })` type-check, with
 * the missing nested fields filled in by the resolver from `DEFAULT_CONFIG`.
 */
export interface LimnUserConfig {
  readonly defaultModel?: ModelName;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryConfig>;
  readonly trace?: Partial<TraceConfig>;
}

export function defineConfig(config: LimnUserConfig): LimnUserConfig {
  return config;
}
