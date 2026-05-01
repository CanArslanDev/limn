/**
 * `Hook` that scrubs known API-key patterns from the per-call request,
 * response, and error before they reach `TraceHook`. Coordinates with
 * `TraceHook` via a shared {@link TraceState} (the dispatcher's
 * `HookContext` is read-only; first-party hooks share state explicitly
 * rather than smuggling extra fields onto the context).
 *
 * Why a separate hook (vs. baking redaction into TraceHook): redaction is
 * opt-out via `TraceworksConfig.trace.redactKeys`. Splitting the concerns lets
 * the factory drop RedactionHook entirely when the user opts out, instead
 * of branching inside TraceHook on every call. Smaller surface, simpler
 * tests, no dead branches at runtime.
 *
 * Phase order (relies on dispatcher's registration-order firing):
 *
 *   onCallStart(RedactionHook) -> onCallStart(TraceHook)
 *   onCallSuccess(RedactionHook) -> onCallSuccess(TraceHook)
 *   onCallError(RedactionHook) -> onCallError(TraceHook)
 *   onCallEnd(TraceHook)
 *
 * The factory is responsible for placing RedactionHook ahead of TraceHook
 * in the hook list. TraceHook.onCallEnd reads `state.request`,
 * `state.response`, `state.error`, `state.redactedFields` which are all
 * populated by RedactionHook in the prior phases.
 */

import type { TraceworksError } from "../errors/index.js";
import { redactKeys } from "../trace/redaction.js";
import type { Hook, HookContext } from "./dispatcher.js";
import type { TraceState } from "./trace_state.js";

export interface RedactionHookOptions {
  /** Shared per-call mutable scratch. Mutated by every phase. */
  readonly state: TraceState;
  /**
   * The full provider request as it left the client. Captured at
   * construction so the hook does not depend on the dispatcher carrying
   * the full request through the context (it does not).
   */
  readonly request: unknown;
}

export class RedactionHook implements Hook {
  public readonly name = "redaction";
  private readonly state: TraceState;
  private readonly request: unknown;

  public constructor(options: RedactionHookOptions) {
    this.state = options.state;
    this.request = options.request;
  }

  /**
   * Walk the captured request through the redactor and persist the
   * cleaned shape on the shared state. Dot-paths are prefixed with
   * `request.` so the persisted record disambiguates "where in the
   * record" the redaction happened. A top-level redaction (the request
   * itself was a string) becomes the bare `request` path.
   */
  public async onCallStart(_ctx: HookContext): Promise<void> {
    const { value, redacted } = redactKeys(this.request);
    this.state.request = value;
    for (const path of redacted) {
      this.state.redactedFields.push(path === "" ? "request" : `request.${path}`);
    }
  }

  /**
   * Capture the response slice the dispatcher knows about (content +
   * usage tokens) and run it through the redactor. Tokens are numbers
   * so they pass through untouched; `content` is the string most likely
   * to leak a key the model echoed back.
   */
  public async onCallSuccess(ctx: HookContext): Promise<void> {
    if (ctx.response === undefined) return;
    const { value, redacted } = redactKeys(ctx.response);
    this.state.response = value;
    for (const path of redacted) {
      this.state.redactedFields.push(path === "" ? "response" : `response.${path}`);
    }
  }

  /**
   * Capture the error code + redacted message. Codes are sealed enums so
   * they never carry a key; the message is the leaky surface (an SDK
   * may echo the offending Authorization header into its error string).
   */
  public async onCallError(ctx: HookContext): Promise<void> {
    if (ctx.error === undefined) return;
    const err: TraceworksError = ctx.error;
    const { value: cleanedMessage, redacted } = redactKeys(err.message);
    this.state.error = {
      code: err.code,
      message: typeof cleanedMessage === "string" ? cleanedMessage : err.message,
    };
    // redactKeys on a string returns "" as the only locator; we surface
    // this as "error.message" without further path concatenation.
    for (const _ of redacted) {
      this.state.redactedFields.push("error.message");
    }
  }
}
