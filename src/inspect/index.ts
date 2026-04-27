/**
 * `limn/inspect` - Phase 2 placeholder. Will export the small Hono server +
 * React UI that ships under `npx limn inspect`. Today re-exports trace types
 * so external tooling can speak the same record shape.
 */

export type { TraceRecord, TraceSink } from "../trace/trace.js";

export function startInspectServer(_port = 3000): never {
  throw new Error(
    "limn inspect server is not implemented yet (Phase 2). Use the trace " +
      "files in .limn/traces/ directly until the UI ships.",
  );
}
