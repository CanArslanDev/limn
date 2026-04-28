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

/**
 * Read-only state delivered to every hook phase. The dispatcher mints a fresh
 * context for each phase by spreading the prior state plus whatever the phase
 * adds (`response` on success, `error` on failure). Hooks treat this as
 * immutable; if a hook needs cross-phase memory it keeps its own state.
 */
export interface HookContext {
  /** Trace ID, prefixed `trc_`, mintied once at call entry. Stable across phases. */
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

type Phase = "onCallStart" | "onCallSuccess" | "onCallError" | "onCallEnd";

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
 * Generates a `trc_<uuid>` trace ID. Uses `crypto.randomUUID` (Node 20.10+
 * has it on the global). Module-level export so callers (`ai.ask`,
 * future `ai.chat`) mint trace IDs without reaching through a static
 * method on the dispatcher class. When the trace pipeline lands (batch
 * 1.4) the helper moves to `src/trace/` per the shared-helper-first
 * principle; the existing import path becomes a re-export at that point.
 */
export function newTraceId(): string {
  return `trc_${crypto.randomUUID()}`;
}

/**
 * Coordinates the five lifecycle phases around a single provider call.
 *
 * For batch 1.1 the dispatcher executes exactly one attempt: retry strategy
 * lands in batch 1.3 and will drive multiple attempts via the same `exec`
 * callback. The phase contract documented on `Hook` is honored regardless
 * of attempt count.
 *
 * Hook callbacks that throw are caught and logged via `console.warn`; the
 * dispatcher then continues to the next hook for the same phase. Throwing a
 * critical hook (trace, retry) therefore degrades observability but keeps
 * the user-visible call alive.
 */
export class HookDispatcher {
  private readonly hooks: readonly Hook[];

  public constructor(hooks: readonly Hook[] = []) {
    this.hooks = hooks;
  }

  /**
   * Run `exec` wrapped in the lifecycle phases. The `initialCtx` carries the
   * fields known before the first attempt (trace ID, resolved model, frozen
   * messages); the dispatcher stamps the attempt counter and, after the
   * attempt, the response / error.
   */
  public async run<T extends DispatcherResult>(
    initialCtx: Omit<HookContext, "attempt" | "response" | "error">,
    exec: (attempt: number) => Promise<T>,
  ): Promise<T> {
    let ctx: HookContext = { ...initialCtx, attempt: 1 };
    await this.fire("onCallStart", ctx);
    try {
      const result = await exec(1);
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
      ctx = { ...ctx, error: wrapped };
      await this.fire("onCallError", ctx);
      throw err;
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
    return new ProviderError(err instanceof Error ? err.message : String(err), "unknown", err);
  }
}
