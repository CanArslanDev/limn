/**
 * Project-level configuration. Resolved from defaults -> env vars ->
 * `traceworks.config.ts` -> per-agent options -> per-call options. Each layer
 * overrides the previous; only the leaves a user actually sets travel
 * down the stack.
 */

import type { ModelName } from "../providers/model_name.js";
import { DEFAULT_MODEL } from "../providers/model_name.js";

export interface TraceworksConfig {
  readonly defaultModel: ModelName;
  readonly retry: RetryConfig;
  readonly trace: TraceConfig;
  readonly timeoutMs: number;
}

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly backoff: "exponential" | "linear" | "none";
  readonly initialDelayMs: number;
}

export interface TraceConfig {
  readonly enabled: boolean;
  readonly dir: string;
  readonly redactKeys: boolean;
}

export const DEFAULT_CONFIG: TraceworksConfig = {
  defaultModel: DEFAULT_MODEL,
  retry: {
    maxAttempts: 3,
    backoff: "exponential",
    initialDelayMs: 500,
  },
  trace: {
    enabled: true,
    dir: ".traceworks/traces",
    redactKeys: true,
  },
  timeoutMs: 60_000,
};
