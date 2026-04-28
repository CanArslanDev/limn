/**
 * Mutable per-call scratch shared between {@link RedactionHook} and
 * {@link TraceHook}. Hooks declared in `src/hooks/dispatcher.ts` see a
 * read-only `HookContext` per phase; that contract is intentional (it keeps
 * arbitrary third-party hooks from rewriting one another's view of the
 * call). Trace + redaction are first-party hooks that legitimately
 * coordinate, so they share this object explicitly via constructor
 * injection rather than smuggling extra fields onto `HookContext`.
 *
 * Lifecycle: the dispatcher factory in `src/client/ai.ts` mints one
 * `TraceState` per call and passes the same instance to both hooks. The
 * object dies with the factory closure when the call returns. Nothing
 * outside the per-call hook stack ever touches it.
 *
 * Why mutable: the alternative (returning a new state from each hook
 * phase) would force a thread-through pattern the dispatcher does not
 * support. Mutation is contained to two hook classes that are written
 * together; the surface is small enough that reasoning stays local.
 *
 * What this state does NOT carry: the attempt counter. That value is
 * owned by the dispatcher and arrives on `HookContext.attempt` for every
 * phase; `TraceHook.onCallEnd` reads it from the context directly when
 * building the persisted record. Mirroring it here would create two
 * sources of truth for the same number.
 */

export interface TraceState {
  /**
   * Trace ID. Stable across phases. Used in the persisted record's `id`
   * field so callers can cross-reference the trace in the inspector.
   */
  readonly id: string;
  /**
   * Wall-clock millisecond when the call began (set in `onCallStart`).
   * Used together with `finishedAtMs` to compute `latencyMs`.
   */
  startedAtMs?: number;
  /**
   * Wall-clock millisecond when the call ended (set in `onCallEnd`).
   */
  finishedAtMs?: number;
  /**
   * The provider request after redaction. RedactionHook.onCallStart
   * populates this; TraceHook reads it for the persisted record. When
   * RedactionHook is omitted from the stack, TraceHook falls back to
   * the raw request supplied at construction.
   */
  request?: unknown;
  /**
   * The response shape after redaction. Set by RedactionHook on success.
   */
  response?: unknown;
  /**
   * Error info on failure. Message is post-redaction so a leaked key in
   * the SDK error text is scrubbed before persist.
   */
  error?: { readonly code: string; readonly message: string };
  /**
   * Dot-paths of every field RedactionHook mutated. Empty when redaction
   * is disabled or nothing matched. The persisted record copies this
   * verbatim so the inspector can surface "what was redacted" without
   * leaking the secret itself.
   */
  redactedFields: string[];
}
