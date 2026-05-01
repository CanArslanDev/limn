/**
 * The `ai` namespace - Layer 1 entry point. All four members (`ask`, `chat`,
 * `extract`, `stream`) are wired against the `HookDispatcher` + provider
 * registry as of batch 1.7; `agent` (Layer 2) lands in Phase 3.
 */

import type { z } from "zod";
import { agent } from "../agent/agent.js";
import type { ChatMessage as ProviderChatMessage } from "../client/options.js";
import { DEFAULT_CONFIG, type LimnConfig } from "../config/limn_config.js";
import { runExtract } from "../extract/extract.js";
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

/**
 * Per-call context handed to the dispatcher factory. The trace + redaction
 * hooks need to capture the request shape, the resolved model, and the
 * provider name into the persisted record; the factory builds them up
 * fresh per call from this object.
 *
 * Tests that only care about the retry/sleep behavior (not trace) ignore
 * the context arg and build a hook-less dispatcher.
 *
 * Asymmetric construction note: per-call values (model, provider, request,
 * trace state) flow through this context because they change every call.
 * Cross-call values (sink, retry strategy, resolved config) live on the
 * factory closure. {@link buildDefaultDispatcher} bridges the two.
 *
 * @internal not part of the public surface; do not import from `limn`.
 *   Prefer constructing your own `HookDispatcher` if you need custom wiring.
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
 *
 * @internal not part of the public surface; do not import from `limn`.
 *   Used by the default dispatcher factory and by integration tests that
 *   need to override the trace dir. Construct your own `HookDispatcher`
 *   directly if you need custom wiring.
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

/**
 * Split a user-supplied chat message array into a top-level `system` string
 * and the remaining (system-free) message array. Provider adapters route the
 * `system` slot through their vendor's dedicated channel (Anthropic's
 * top-level `system` field; OpenAI's leading `role: "system"` message); the
 * `ChatMessage` array passed to the dispatcher therefore must not contain
 * `role: "system"` entries.
 *
 * Resolution rule (matches `ChatOptions.system`'s JSDoc): when an in-array
 * system message is present it wins over `optionsSystem`. The first
 * in-array system message's content is taken; subsequent system messages
 * are silently dropped - no warning, no concatenation. This keeps the
 * contract simple: "system message" is single-valued at the provider
 * level, regardless of how many appear in the input array. The pinning
 * test lives in `test/integration/chat_smoke.test.ts` so a future
 * refactor cannot accidentally start concatenating.
 */
function splitChatMessages(
  messages: readonly ChatMessage[],
  optionsSystem: string | undefined,
): { system: string | undefined; userMessages: readonly ProviderChatMessage[] } {
  let inArraySystem: string | undefined;
  const userMessages: ProviderChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (inArraySystem === undefined) inArraySystem = m.content;
      continue;
    }
    userMessages.push({ role: m.role, content: m.content });
  }
  return {
    system: inArraySystem ?? optionsSystem,
    userMessages,
  };
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
      ...(options?.attachments === undefined ? {} : { attachments: options.attachments }),
    };

    const traceId = newTraceId();
    const state: TraceState = { id: traceId, redactedFields: [] };
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

  async chat(messages, options) {
    const model = options?.model ?? DEFAULT_CONFIG.defaultModel;
    const providerName = providerFor(model);
    const provider = getProvider(providerName);

    const { system, userMessages } = splitChatMessages(messages, options?.system);
    const baseRequest: ProviderRequest = {
      model,
      messages: userMessages,
      ...(system === undefined ? {} : { system }),
      ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.attachments === undefined ? {} : { attachments: options.attachments }),
    };

    const traceId = newTraceId();
    const state: TraceState = { id: traceId, redactedFields: [] };
    const dispatcher = currentDispatcherFactory({
      state,
      kind: "chat",
      model,
      provider: providerName,
      request: baseRequest,
    });
    const result = await dispatcher.run(
      {
        traceId,
        model,
        messages: userMessages,
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

  async extract(schema, input, options) {
    const model = options?.model ?? DEFAULT_CONFIG.defaultModel;
    const providerName = providerFor(model);
    const provider = getProvider(providerName);

    // Each chat call inside the extract flow shares the same per-call
    // dispatcher kind ("extract") so the trace records the orchestration's
    // intent, not the underlying chat plumbing. The callback rebuilds the
    // request per attempt because the message list grows on retry; the
    // dispatcher therefore runs once per chat attempt, not once per retry
    // attempt of the extract loop.
    const callChat = async (messages: readonly ProviderChatMessage[]): Promise<string> => {
      const { system, userMessages } = splitChatMessages(messages, undefined);
      const baseRequest: ProviderRequest = {
        model,
        messages: userMessages,
        ...(system === undefined ? {} : { system }),
        ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.attachments === undefined ? {} : { attachments: options.attachments }),
      };
      const traceId = newTraceId();
      const state: TraceState = { id: traceId, redactedFields: [] };
      const dispatcher = currentDispatcherFactory({
        state,
        kind: "extract",
        model,
        provider: providerName,
        request: baseRequest,
      });
      const result = await dispatcher.run({ traceId, model, messages: userMessages }, async () => {
        const response = await provider.request(baseRequest);
        return {
          content: response.content,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        };
      });
      return result.content;
    };

    return runExtract(schema, input, callChat, {
      ...(options?.retryOnSchemaFailure === undefined
        ? {}
        : { retryOnSchemaFailure: options.retryOnSchemaFailure }),
    });
  },

  stream(prompt, options) {
    const model = options?.model ?? DEFAULT_CONFIG.defaultModel;
    const providerName = providerFor(model);
    const provider = getProvider(providerName);

    const messages = buildAskMessages(prompt);
    const baseRequest: ProviderRequest = {
      model,
      messages,
      ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.attachments === undefined ? {} : { attachments: options.attachments }),
    };

    const traceId = newTraceId();
    const state: TraceState = { id: traceId, redactedFields: [] };
    const dispatcher = currentDispatcherFactory({
      state,
      kind: "stream",
      model,
      provider: providerName,
      request: baseRequest,
    });
    const onChunk = options?.onChunk;

    // Wrap the dispatcher's runStream so we can fire `onChunk` per chunk
    // before yielding to the consumer. The dispatcher handles retry,
    // tracing, and lifecycle phases; we just decorate.
    async function* streamWithCallback(): AsyncIterable<string> {
      const inner = dispatcher.runStream({ traceId, model, messages }, (_attempt) => {
        const { stream: providerStream, usage } = provider.requestStream(baseRequest);
        return { stream: providerStream, finalize: usage };
      });
      for await (const chunk of inner) {
        if (onChunk !== undefined) onChunk(chunk);
        yield chunk;
      }
    }
    return streamWithCallback();
  },

  agent,
};
