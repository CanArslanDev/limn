/**
 * Barrel for the hooks layer. Internal-only: hook authoring is part of the
 * public API but is exported through `src/index.ts` once a hook-registration
 * surface lands (batch 1.3 retry hook). For now batch 1.1 keeps the
 * dispatcher internal.
 */
export { HookDispatcher } from "./dispatcher.js";
export type { Hook, HookContext } from "./dispatcher.js";
