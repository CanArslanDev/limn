/**
 * Lifecycle hook primitive shared by every Layer 1 call (and, in later
 * batches, Layer 2 agent loops). Hooks are observers: they react to the
 * five phases of a provider call but cannot alter control flow. Retry
 * (batch 1.3) and trace (batch 1.4) are the two production hooks that
 * land on top of this primitive; the dispatcher itself is featureless
 * scaffolding so those land cleanly without bespoke wiring.
 *
 * Why land hooks before retry / trace: the alternative is bolting both
 * concerns directly into `ai.ask`, which means each later batch has to
 * re-thread the call site instead of registering one more hook. Centralizing
 * the lifecycle now also makes test instrumentation trivial: a test hook
 * is just an object literal.
 *
 * Hook errors do NOT crash the call. Hooks may be third-party (logger
 * integrations, telemetry sinks) and a buggy logger should never poison the
 * model output. We catch + warn per-phase so other hooks still run.
 */
import type { ChatMessage } from "../client/options.js";
import { LimnError, ProviderError } from "../errors/index.js";
import type { ModelName } from "../providers/model_name.js";
import { newTraceId as _newTraceId } from "../trace/trace_id.js";
import { NO_RETRY, type RetryStrategy } from "./retry_strategy.js";

/**
 * Re-export of the canonical {@link newTraceId} helper. The source of truth
 * lives at `src/trace/trace_id.ts` (CLAUDE.md §13.8 shared-helper-first
 * principle); this re-export preserves the historical import path
 * (`from "../hooks/dispatcher.js"`) so call sites established in batch 1.1
 * (notably `src/client/ai.ts`) keep working without churn. New code should
 * prefer the trace-layer import directly.
 */
export const newTraceId: typeof _newTraceId = _newTraceId;

/**
 * Read-only state delivered to every hook phase. The dispatcher mints a fresh
 * context for each phase by spreading the prior state plus whatever the phase
 * adds (`response` on success, `error` on failure). Hooks treat this as
 * immutable; if a hook needs cross-phase memory it keeps its own state.
 */
export interface HookContext {
  /** Trace ID, prefixed `trc_`, minted once at call entry. Stable across phases. */
  readonly traceId: string;
  /** Model the call resolved to (post option-merge). */
  readonly model: ModelName;
  /** The chat messages the provider received. Verbatim, post-merge. */
  readonly messages: readonly ChatMessage[];
  /** 1-based attempt counter. Always 1 in batch 1.1; the retry hook bumps it later. */
  readonly attempt: number;
  /** Populated only after `onCallSuccess`. */
  readonly response?: {
    readonly content: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  /** Populated only after `onCallError`. Always a `LimnError` subclass. */
  readonly error?: LimnError;
}

/**
 * A hook is a partial bag of phase callbacks. Any phase the hook does not
 * implement is skipped. This keeps simple hooks (a one-line success logger)
 * trivial while leaving room for the trace hook (batch 1.4) to implement
 * every phase.
 *
 * Phases in firing order on a successful call:
 *   onCallStart -> exec -> onCallSuccess -> onCallEnd
 *
 * On a failing call:
 *   onCallStart -> exec(throws) -> onCallError -> onCallEnd
 *
 * `onRetry` is reserved for batch 1.3 (retry strategy) and is currently never
 * fired by the dispatcher. The phase exists in the interface now so hooks
 * defined today will Just Work when the retry strategy lands.
 */
export interface Hook {
  /** Identifier shown in warnings if a hook callback throws. */
  readonly name: string;
  onCallStart?(ctx: HookContext): void | Promise<void>;
  onCallSuccess?(ctx: HookContext): void | Promise<void>;
  onCallError?(ctx: HookContext): void | Promise<void>;
  onRetry?(ctx: HookContext): void | Promise<void>;
  onCallEnd?(ctx: HookContext): void | Promise<void>;
}

type Phase = "onCallStart" | "onCallSuccess" | "onCallError" | "onRetry" | "onCallEnd";

/**
 * The shape the dispatcher's `exec` must return. Mirrors the relevant slice
 * of `ProviderResponse` (content + token counts). The dispatcher does not
 * need the rest of `ProviderResponse`; the caller stores it separately.
 */
export interface DispatcherResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Default sleep implementation used when the dispatcher's `sleepFn` option is
 * omitted. `setTimeout` lives behind a Promise so the retry loop reads as
 * straight-line `await`. Tests inject a recording sleep that resolves
 * synchronously; production gets the real wall-clock pause.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Construction options for {@link HookDispatcher}. Options-object form so
 * later batches (trace pipeline, agent loop) can extend the surface without
 * breaking call sites.
 *
 * Backward compatibility: passing a plain `readonly Hook[]` to the
 * constructor is still supported (legacy batch 1.1 call sites used the array
 * form). New call sites prefer the options object.
 */
export interface HookDispatcherOptions {
  /** Hooks to fire on each lifecycle phase. Defaults to none. */
  readonly hooks?: readonly Hook[];
  /**
   * Retry strategy consulted between attempts. Defaults to {@link NO_RETRY}
   * so the legacy "exec runs exactly once" behavior is preserved when no
   * strategy is supplied.
   */
  readonly retry?: RetryStrategy;
  /**
   * Sleep implementation invoked between attempts. Tests inject a recording
   * sleep that resolves synchronously and captures the requested delay so
   * assertions can verify the strategy's decision. Production omits this and
   * the dispatcher uses a `setTimeout`-backed sleep.
   */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Coordinates the five lifecycle phases around a single provider call,
 * including the retry loop driven by the configured {@link RetryStrategy}.
 *
 * Lifecycle on success after N attempts (N - 1 retries):
 *   onCallStart -> exec(1) -> [throw -> onRetry -> sleep -> exec(2) -> ...]
 *   -> onCallSuccess -> onCallEnd
 *
 * Lifecycle on terminal failure:
 *   onCallStart -> exec(1) -> [...] -> onCallError -> onCallEnd
 *
 * `onCallStart` and `onCallEnd` fire exactly once each, at the bookends.
 * `onRetry` fires once before each retry attempt (so for N attempts, N - 1
 * times). Hook callbacks that throw are caught and logged via `console.warn`;
 * the dispatcher then continues to the next hook for the same phase. A
 * buggy hook (trace, telemetry) therefore degrades observability but keeps
 * the user-visible call alive.
 */
export class HookDispatcher {
  private readonly hooks: readonly Hook[];
  private readonly retry: RetryStrategy;
  private readonly sleepFn: (ms: number) => Promise<void>;

  /**
   * Construct a dispatcher. Accepts either a {@link HookDispatcherOptions}
   * object (preferred) or a plain `readonly Hook[]` (legacy form, kept for
   * backward compatibility with batch 1.1 call sites). When an array is
   * passed the dispatcher uses {@link NO_RETRY} and the default sleep.
   */
  public constructor(options: HookDispatcherOptions | readonly Hook[] = {}) {
    // `Array.isArray` does not narrow the union's non-array branch back to
    // `HookDispatcherOptions` cleanly (TS keeps the original union). Cast the
    // non-array branch through the explicit shape so the field assignments
    // below see plain `HookDispatcherOptions`.
    const opts: HookDispatcherOptions = Array.isArray(options)
      ? { hooks: options as readonly Hook[] }
      : (options as HookDispatcherOptions);
    this.hooks = opts.hooks ?? [];
    this.retry = opts.retry ?? NO_RETRY;
    this.sleepFn = opts.sleepFn ?? defaultSleep;
  }

  /**
   * Run `exec` inside the retry loop, wrapped in the lifecycle phases. The
   * `initialCtx` carries the fields known before the first attempt (trace ID,
   * resolved model, frozen messages); the dispatcher stamps the attempt
   * counter, fires `onRetry` between attempts, and populates `response` /
   * `error` on the context after each attempt for the relevant phase.
   *
   * `onCallStart` fires once before the first attempt; `onCallEnd` fires once
   * after the final outcome (success or terminal failure). The retry strategy
   * decides whether each thrown error is retried or surfaced; on retry the
   * dispatcher sleeps for the strategy's returned delay and increments the
   * attempt counter before invoking `exec` again.
   */
  public async run<T extends DispatcherResult>(
    initialCtx: Omit<HookContext, "attempt" | "response" | "error">,
    exec: (attempt: number) => Promise<T>,
  ): Promise<T> {
    let ctx: HookContext = { ...initialCtx, attempt: 1 };
    await this.fire("onCallStart", ctx);
    let attempt = 0;
    try {
      while (true) {
        attempt += 1;
        // Strip `error` and `response` from the prior iteration so a
        // successful retry does not surface the failed attempt's `error` to
        // `onCallSuccess`/`onCallEnd`. The JSDoc on `HookContext.error` /
        // `HookContext.response` (above) names "populated only after the
        // matching phase" as the contract; we enforce it here. The
        // destructure-omit pattern is the cleanest fit for
        // `exactOptionalPropertyTypes`: spreading `error: undefined`
        // explicitly would re-introduce the key on the new object.
        const { error: _droppedError, response: _droppedResponse, ...prior } = ctx;
        ctx = { ...prior, attempt };
        if (attempt > 1) {
          await this.fire("onRetry", ctx);
        }
        try {
          const result = await exec(attempt);
          ctx = {
            ...ctx,
            response: {
              content: result.content,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
            },
          };
          await this.fire("onCallSuccess", ctx);
          return result;
        } catch (err) {
          const wrapped = this.toLimnError(err);
          const delayMs = this.retry.decide(attempt, wrapped);
          if (delayMs === null) {
            ctx = { ...ctx, error: wrapped };
            await this.fire("onCallError", ctx);
            throw err;
          }
          ctx = { ...ctx, error: wrapped };
          await this.sleepFn(delayMs);
        }
      }
    } finally {
      await this.fire("onCallEnd", ctx);
    }
  }

  private async fire(phase: Phase, ctx: HookContext): Promise<void> {
    for (const hook of this.hooks) {
      const fn = hook[phase];
      if (fn === undefined) continue;
      try {
        await fn.call(hook, ctx);
      } catch (err) {
        // Hooks must not poison the call. Surface the failure on stderr so
        // operators notice; do not rethrow. `console.warn` is allowed by the
        // project's Biome config (see biome.json `noConsole.allow`).
        console.warn(`[limn] hook "${hook.name}" failed in ${phase}:`, err);
      }
    }
  }

  /**
   * Normalize an unknown thrown value into a `LimnError`. Hooks always see a
   * typed error in `ctx.error`; downstream rethrow keeps the original value
   * so the public surface preserves whatever the provider raised.
   *
   * Narrows on the abstract `LimnError` base, not on `ProviderError`, so
   * every typed subclass (RateLimitError, AuthError, ModelTimeoutError,
   * SchemaValidationError, ToolExecutionError) reaches the hook unchanged.
   * Anything else (a bare `Error`, a string throw) is wrapped in a generic
   * `ProviderError` with provider="unknown" so the typed-error contract on
   * `HookContext.error` holds for arbitrary throws too.
   */
  private toLimnError(err: unknown): LimnError {
    if (err instanceof LimnError) return err;
    // Unknown throws are deterministic by assumption: we have no signal that
    // re-issuing the same request would behave differently, so mark the
    // wrapper non-retryable. Mirrors the philosophy in
    // `anthropic_provider.ts` for the "Unexpected ... error" catch-all.
    return new ProviderError(
      err instanceof Error ? err.message : String(err),
      "unknown",
      err,
      false,
    );
  }
}
