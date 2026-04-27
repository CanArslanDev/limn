/**
 * Local trace pipeline. Phase 1 default sink writes one JSON record per call
 * to `.limn/traces/<traceId>.json`. The schema is intentionally stable so the
 * inspector (Phase 2) and the optional hosted backend (Phase 5) read the
 * same shape.
 */

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
