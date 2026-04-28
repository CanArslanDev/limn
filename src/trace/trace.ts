/**
 * Local trace pipeline. Phase 1 default sink writes one JSON record per call
 * to `.limn/traces/<traceId>.json`. The schema is intentionally stable so the
 * inspector (Phase 2) and the optional hosted backend (Phase 5) read the
 * same shape.
 */

// TODO(phase-2): consider raw ms vs ISO string for `timestamp`; the ISO
//   form is human-friendly today, but the inspector may prefer raw ms for
//   cheap arithmetic. Decide once the Phase 2 contract is set.
export interface TraceRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: "ask" | "chat" | "extract" | "stream" | "agent" | "tool";
  readonly model: string;
  readonly provider: string;
  readonly latencyMs: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly request: unknown;
  readonly response: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  /**
   * Total attempts the call took, 1-based. `1` for first-try success or
   * non-retryable failure; `>1` when the retry strategy ran. The dispatcher's
   * `attempt` counter at end-of-call feeds this directly.
   */
  readonly attempts: number;
  /**
   * Dot-paths inside `request`, `response`, or `error` whose strings had at
   * least one substring replaced by `[REDACTED]`. Empty when nothing matched
   * the redactor's patterns or `trace.redactKeys` is `false`.
   */
  readonly redactedFields: readonly string[];
  /**
   * Trace ID of the parent call when this record sits inside a larger
   * operation (Phase 3 agent loops, tool dispatches). Absent for top-level
   * Layer 1 calls.
   */
  readonly parentTraceId?: string;
}

export interface TraceSink {
  write(record: TraceRecord): Promise<void>;
  list(): Promise<readonly TraceRecord[]>;
  read(id: string): Promise<TraceRecord | null>;
}

/**
 * Phase 1 placeholder. The real filesystem-backed sink lands with the trace
 * implementation; the no-op sink lets the public surface compile and lets
 * tests inject a recording sink without filesystem I/O.
 */
export const noopSink: TraceSink = {
  async write(_record) {
    // intentional no-op
  },
  async list() {
    return [];
  },
  async read(_id) {
    return null;
  },
};
