/**
 * The `ai` namespace - Layer 1 entry point. `ai.ask` is wired in batch 1.1
 * against the `HookDispatcher` + provider registry. The remaining members
 * (`chat`, `extract`, `stream`) stay as Phase 1 placeholders until their
 * batches land (batch 1.5 chat, batch 1.6 extract, batch 1.7 stream).
 */

import type { z } from "zod";
import { agent } from "../agent/agent.js";
import type { ChatMessage as ProviderChatMessage } from "../client/options.js";
import { DEFAULT_CONFIG, type LimnConfig } from "../config/limn_config.js";
import { type Hook, HookDispatcher, newTraceId } from "../hooks/dispatcher.js";
import { RedactionHook } from "../hooks/redaction_hook.js";
import { ExponentialBackoffStrategy } from "../hooks/retry_strategy.js";
import { TraceHook } from "../hooks/trace_hook.js";
import type { TraceState } from "../hooks/trace_state.js";
import type { ModelName } from "../providers/model_name.js";
import type { ProviderRequest } from "../providers/provider.js";
import { type ProviderName, getProvider, providerFor } from "../providers/registry.js";
import { FileSystemTraceSink } from "../trace/file_sink.js";
import { type TraceRecord, type TraceSink, noopSink } from "../trace/trace.js";
import type {
  AskOptions,
  ChatMessage,
  ChatOptions,
  ExtractOptions,
  StreamOptions,
} from "./options.js";

export interface Ai {
  ask(prompt: string, options?: AskOptions): Promise<string>;
  ask(prompt: string, context: string, options?: AskOptions): Promise<string>;

  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string>;

  extract<T>(schema: z.ZodSchema<T>, input: string, options?: ExtractOptions): Promise<T>;

  stream(prompt: string, options?: StreamOptions): AsyncIterable<string>;

  readonly agent: typeof agent;
}

const notImplemented = (fn: string): never => {
  throw new Error(`ai.${fn} is not implemented yet (Phase 1).`);
};

/**
 * Per-call context handed to the dispatcher factory. The trace + redaction
 * hooks need to capture the request shape, the resolved model, and the
 * provider name into the persisted record; the factory builds them up
 * fresh per call from this object.
 *
 * Tests that only care about the retry/sleep behavior (not trace) ignore
 * the context arg and build a hook-less dispatcher.
 */
export interface DispatcherFactoryContext {
  readonly state: TraceState;
  readonly kind: TraceRecord["kind"];
  readonly model: ModelName;
  readonly provider: ProviderName;
  readonly request: ProviderRequest;
}

/**
 * Factory that builds the dispatcher used by every public `ai.*` call. The
 * default wires the production retry strategy (exponential backoff against
 * `DEFAULT_CONFIG.retry`) and the production trace + redaction hooks
 * (writing to `.limn/traces/` per `DEFAULT_CONFIG.trace`). Tests replace
 * the factory via {@link __setDispatcherFactoryForTests} to inject a
 * recording `sleepFn`, swap the sink for a recording one, or pin
 * `LimnConfig.trace.dir` to an isolated tmp directory.
 *
 * The factory takes a per-call context so the trace hook can capture the
 * exact request that left the client; building the hook stack inside the
 * factory keeps `ai.ask` short and pushes the wiring into one named
 * helper.
 */
type DispatcherFactory = (ctx: DispatcherFactoryContext) => HookDispatcher;

/**
 * Build the production dispatcher for a single call. Composes the hook
 * stack (RedactionHook before TraceHook so the trace records the cleaned
 * shape), the exponential-backoff retry strategy, and the configured
 * sink. `config` defaults to `DEFAULT_CONFIG`; the integration smoke
 * passes a config pinned to a tmp directory so its trace files do not
 * land in the project's `.limn/`.
 */
export function buildDefaultDispatcher(
  ctx: DispatcherFactoryContext,
  config: LimnConfig = DEFAULT_CONFIG,
): HookDispatcher {
  const sink: TraceSink = config.trace.enabled
    ? new FileSystemTraceSink(config.trace.dir)
    : noopSink;
  const hooks: Hook[] = [];
  if (config.trace.enabled && config.trace.redactKeys) {
    hooks.push(new RedactionHook({ state: ctx.state, request: ctx.request }));
  }
  if (config.trace.enabled) {
    hooks.push(
      new TraceHook({
        state: ctx.state,
        sink,
        kind: ctx.kind,
        provider: ctx.provider,
        model: ctx.model,
        request: ctx.request,
      }),
    );
  }
  return new HookDispatcher({
    hooks,
    retry: new ExponentialBackoffStrategy({ config: config.retry }),
  });
}

const defaultDispatcherFactory: DispatcherFactory = (ctx) => buildDefaultDispatcher(ctx);

let currentDispatcherFactory: DispatcherFactory = defaultDispatcherFactory;

/**
 * Test-only seam for replacing the dispatcher factory. Pass `undefined` to
 * restore the default. The leading underscores mark the export as not part
 * of the stable public API; production code never imports this.
 */
export function __setDispatcherFactoryForTests(factory: DispatcherFactory | undefined): void {
  currentDispatcherFactory = factory ?? defaultDispatcherFactory;
}

/**
 * Normalize the two-arg overload (`ai.ask(prompt, context, options)`) and the
 * single-arg form into a `{ prompt, context?, options? }` triple. When a
 * `context` is supplied it lands as a second user message immediately after
 * the prompt; this is the cleanest mapping that preserves message-role
 * semantics across both Anthropic and OpenAI without a special-cased system
 * channel. (System instructions go through `AskOptions.system` instead.)
 */
function normalizeAskArgs(
  contextOrOptions: string | AskOptions | undefined,
  maybeOptions: AskOptions | undefined,
): { context?: string; options?: AskOptions } {
  if (typeof contextOrOptions === "string") {
    return maybeOptions === undefined
      ? { context: contextOrOptions }
      : { context: contextOrOptions, options: maybeOptions };
  }
  return contextOrOptions === undefined ? {} : { options: contextOrOptions };
}

/**
 * Build the message array for `ai.ask`. The prompt is always the first user
 * message; an optional `context` is appended as a second user message so the
 * model sees them as the same speaker. System instructions, when supplied,
 * are passed via the dedicated `system` field on `ProviderRequest`.
 */
function buildAskMessages(prompt: string, context?: string): readonly ProviderChatMessage[] {
  if (context === undefined) {
    return [{ role: "user", content: prompt }];
  }
  return [
    { role: "user", content: prompt },
    { role: "user", content: context },
  ];
}

export const ai: Ai = {
  async ask(
    prompt: string,
    contextOrOptions?: string | AskOptions,
    maybeOptions?: AskOptions,
  ): Promise<string> {
    const { context, options } = normalizeAskArgs(contextOrOptions, maybeOptions);
    const model = options?.model ?? DEFAULT_CONFIG.defaultModel;
    const providerName = providerFor(model);
    const provider = getProvider(providerName);

    const messages = buildAskMessages(prompt, context);
    const baseRequest: ProviderRequest = {
      model,
      messages,
      ...(options?.system === undefined ? {} : { system: options.system }),
      ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };

    const traceId = newTraceId();
    const state: TraceState = { id: traceId, attempt: 1, redactedFields: [] };
    const dispatcher = currentDispatcherFactory({
      state,
      kind: "ask",
      model,
      provider: providerName,
      request: baseRequest,
    });
    const result = await dispatcher.run(
      {
        traceId,
        model,
        messages,
      },
      async () => {
        const response = await provider.request(baseRequest);
        return {
          content: response.content,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        };
      },
    );

    return result.content;
  },

  async chat(_messages, _options) {
    return notImplemented("chat");
  },

  async extract(_schema, _input, _options) {
    return notImplemented("extract");
  },

  stream(_prompt, _options) {
    throw new Error("ai.stream is not implemented yet (Phase 1).");
  },

  agent,
};
