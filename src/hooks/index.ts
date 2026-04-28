/**
 * Barrel for the hooks layer. Internal-only: hook authoring is part of the
 * public API but is exported through `src/index.ts` once a hook-registration
 * surface lands (batch 1.4 trace hook). For now batches 1.1 and 1.3 keep
 * the dispatcher and the retry strategy internal.
 */
export { HookDispatcher, newTraceId } from "./dispatcher.js";
export type { Hook, HookContext, HookDispatcherOptions } from "./dispatcher.js";
export { ExponentialBackoffStrategy, NO_RETRY } from "./retry_strategy.js";
export type { ExponentialBackoffOptions, RetryStrategy } from "./retry_strategy.js";
