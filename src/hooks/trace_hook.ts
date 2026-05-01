/**
 * `Hook` that captures call timing + outcome and writes a `TraceRecord`
 * to the configured sink at `onCallEnd`. First-party hook; coordinates
 * with `RedactionHook` via a shared {@link TraceState}.
 *
 * Phase responsibilities:
 *  - `onCallStart`: stamp `startedAtMs` if not already set (RedactionHook
 *    runs first when present, but the hook is self-sufficient when
 *    redaction is disabled).
 *  - `onCallSuccess`: capture the response slice for the persisted
 *    record. Skipped when RedactionHook already populated `state.response`
 *    (RedactionHook redacts; this hook would overwrite with raw content).
 *  - `onCallError`: capture error code + message. Skipped when
 *    RedactionHook already populated `state.error` (same reasoning).
 *  - `onCallEnd`: build the `TraceRecord`, write to sink. Sink failures
 *    log a `console.warn` rather than throwing; the trace pipeline must
 *    degrade observability rather than break the user's call.
 *
 * Why hand off at end-of-call (vs. streaming events to the sink): the
 * Phase 1 sink (`FileSystemTraceSink`) writes one JSON file per record,
 * which means one file per call. Streaming partial records would force
 * the sink to either accumulate in memory or write incrementally;
 * neither serves the "users browse `.traceworks/traces/<id>.json`" UX. Phase 5
 * (hosted backend) may stream events; the hook will grow that capability
 * when the time comes.
 */

import type { TraceworksError } from "../errors/index.js";
import type { TraceRecord, TraceSink } from "../trace/trace.js";
import type { Hook, HookContext } from "./dispatcher.js";
import type { TraceState } from "./trace_state.js";

export interface TraceHookOptions {
  /** Shared per-call mutable scratch. Read at `onCallEnd`. */
  readonly state: TraceState;
  /** Sink that persists the built record. Failures are caught + warned. */
  readonly sink: TraceSink;
  /** What kind of call this trace records (mirrors `TraceRecord.kind`). */
  readonly kind: TraceRecord["kind"];
  /** Provider name (mirrors `TraceRecord.provider`). */
  readonly provider: string;
  /** Resolved model (mirrors `TraceRecord.model`). */
  readonly model: string;
  /**
   * The provider request as it left the client. Used as the persisted
   * `request` when RedactionHook is omitted from the stack (no
   * `state.request` populated). When RedactionHook is present the
   * cleaned shape on `state.request` wins.
   */
  readonly request: unknown;
}

export class TraceHook implements Hook {
  public readonly name = "trace";
  private readonly state: TraceState;
  private readonly sink: TraceSink;
  private readonly kind: TraceRecord["kind"];
  private readonly provider: string;
  private readonly model: string;
  private readonly request: unknown;

  public constructor(options: TraceHookOptions) {
    this.state = options.state;
    this.sink = options.sink;
    this.kind = options.kind;
    this.provider = options.provider;
    this.model = options.model;
    this.request = options.request;
  }

  public async onCallStart(_ctx: HookContext): Promise<void> {
    if (this.state.startedAtMs === undefined) {
      this.state.startedAtMs = Date.now();
    }
  }

  /**
   * Capture the dispatcher-known response slice when redaction is off
   * (the redaction hook already populated `state.response` when on).
   * Token counts are kept in `usage` on the record; `state.response`
   * is the redaction-friendly mirror used as the record's `response`
   * field.
   */
  public async onCallSuccess(ctx: HookContext): Promise<void> {
    if (ctx.response === undefined) return;
    if (this.state.response === undefined) {
      this.state.response = {
        content: ctx.response.content,
        inputTokens: ctx.response.inputTokens,
        outputTokens: ctx.response.outputTokens,
      };
    }
  }

  public async onCallError(ctx: HookContext): Promise<void> {
    if (ctx.error === undefined) return;
    if (this.state.error === undefined) {
      const err: TraceworksError = ctx.error;
      this.state.error = { code: err.code, message: err.message };
    }
  }

  /**
   * Build the persisted record from the shared state and hand it to the
   * sink. Captures `finishedAtMs` first so `latencyMs` is computed
   * against the moment-of-end rather than against whenever the sink
   * happens to flush. Sink failures are warned; never thrown.
   */
  public async onCallEnd(ctx: HookContext): Promise<void> {
    this.state.finishedAtMs = Date.now();

    const startedAt = this.state.startedAtMs ?? this.state.finishedAtMs;
    const latencyMs = Math.max(0, this.state.finishedAtMs - startedAt);

    const usage = ctx.response
      ? { inputTokens: ctx.response.inputTokens, outputTokens: ctx.response.outputTokens }
      : { inputTokens: 0, outputTokens: 0 };

    const persistedRequest = this.state.request ?? this.request;

    const record: TraceRecord = {
      id: this.state.id,
      timestamp: new Date(startedAt).toISOString(),
      kind: this.kind,
      model: this.model,
      provider: this.provider,
      latencyMs,
      attempts: ctx.attempt,
      usage,
      request: persistedRequest,
      response: this.state.response,
      ...(this.state.error === undefined ? {} : { error: this.state.error }),
      redactedFields: [...this.state.redactedFields],
    };

    try {
      await this.sink.write(record);
    } catch (err) {
      console.warn(
        `[traceworks] trace sink "${this.sink.constructor.name}" failed to write trace ${this.state.id}:`,
        err,
      );
    }
  }
}
