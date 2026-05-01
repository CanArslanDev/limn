/**
 * Configuration resolution chain. Merges four `TraceworksUserConfig` partials in
 * precedence order (defaults < env < traceworks.config.ts < per-call options) into
 * one fully-resolved `TraceworksConfig` with no optional fields.
 *
 * Per-call API key override is intentionally NOT part of this chain: the
 * key is per-provider, not TraceworksConfig-shaped. The client picks it up from
 * `BaseCallOptions.apiKey` and routes it through `resolveProvider` in the
 * registry. Keeping the key out of `TraceworksConfig` also avoids accidental
 * persistence into trace records (the trace pipeline only sees `TraceworksConfig`,
 * never per-call API keys).
 */

import type { TraceworksUserConfig } from "./define_config.js";
import { DEFAULT_CONFIG, type TraceworksConfig } from "./traceworks_config.js";

/**
 * The four resolution layers, top-down (highest precedence first when read,
 * but evaluated bottom-up so the lower layers fill in defaults). Each layer
 * is optional; absent layers contribute no overrides. The `| undefined`
 * spelling on each field accommodates `exactOptionalPropertyTypes: true`,
 * so callers (notably `loadProjectConfig`, which returns `undefined` when
 * no file is present) can spread the result through directly.
 */
export interface ResolveLayers {
  /** Lifted from `process.env`. See {@link envOverridesFromProcess}. */
  readonly envOverrides?: TraceworksUserConfig | undefined;
  /** Loaded from `traceworks.config.{ts,js,cjs,mjs}`. See `loadProjectConfig`. */
  readonly fileConfig?: TraceworksUserConfig | undefined;
  /** Per-call options lifted into TraceworksConfig shape. */
  readonly callOverrides?: TraceworksUserConfig | undefined;
}

/**
 * Merge layers into a fully-resolved `TraceworksConfig`. Higher layers override
 * lower layers field-by-field; nested groups (`retry`, `trace`) merge per
 * sub-field rather than wholesale, so `{ retry: { maxAttempts: 5 } }` only
 * overrides that one knob and inherits the rest from the lower layer.
 *
 * The implementation reads as a flat ladder of `??` chains (highest first),
 * which mirrors the precedence order at the call site. A future field added
 * to `TraceworksConfig` requires one more line here; the explicit ladder is more
 * scannable than a recursive deep-merge that hides which fields exist.
 */
export function resolveConfig(layers: ResolveLayers): TraceworksConfig {
  const env = layers.envOverrides ?? {};
  const file = layers.fileConfig ?? {};
  const call = layers.callOverrides ?? {};
  return {
    defaultModel:
      call.defaultModel ?? file.defaultModel ?? env.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    timeoutMs: call.timeoutMs ?? file.timeoutMs ?? env.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    retry: {
      maxAttempts:
        call.retry?.maxAttempts ??
        file.retry?.maxAttempts ??
        env.retry?.maxAttempts ??
        DEFAULT_CONFIG.retry.maxAttempts,
      backoff:
        call.retry?.backoff ??
        file.retry?.backoff ??
        env.retry?.backoff ??
        DEFAULT_CONFIG.retry.backoff,
      initialDelayMs:
        call.retry?.initialDelayMs ??
        file.retry?.initialDelayMs ??
        env.retry?.initialDelayMs ??
        DEFAULT_CONFIG.retry.initialDelayMs,
    },
    trace: {
      enabled:
        call.trace?.enabled ??
        file.trace?.enabled ??
        env.trace?.enabled ??
        DEFAULT_CONFIG.trace.enabled,
      dir: call.trace?.dir ?? file.trace?.dir ?? env.trace?.dir ?? DEFAULT_CONFIG.trace.dir,
      redactKeys:
        call.trace?.redactKeys ??
        file.trace?.redactKeys ??
        env.trace?.redactKeys ??
        DEFAULT_CONFIG.trace.redactKeys,
    },
  };
}

/**
 * Lift documented Traceworks env vars into a `TraceworksUserConfig` partial. Today only
 * `TRACEWORKS_TRACE_DIR` is recognized (per CLAUDE.md section 13.7's canonical
 * example). Unrecognized `TRACEWORKS_*` vars are intentionally NOT promoted so
 * the env surface stays explicit; new vars must add a switch arm here AND
 * land in `guides/getting-started.md` so the surface stays documented.
 *
 * Provider-specific keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are NOT
 * lifted here because they belong to the provider boundary, not to
 * `TraceworksConfig`. The provider registry reads them directly during the lazy
 * bootstrap.
 */
export function envOverridesFromProcess(): TraceworksUserConfig {
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket notation under TS noPropertyAccessFromIndexSignature
  const dir = process.env["TRACEWORKS_TRACE_DIR"];
  if (dir === undefined || dir === "") return {};
  return { trace: { dir } };
}
