# API surface reference

Every public function and type that ships from `traceworks`. The README has the 5-minute tour; this is the long form.

> Phase 1 is in flight. As of batch 1.7 all four Layer 1 entry points (`ai.ask`, `ai.chat`, `ai.extract`, `ai.stream`) are wired end-to-end against Anthropic and OpenAI; agent and tool dispatch land in Phase 3.

## `ai` namespace

### `ai.ask(prompt, options?) -> Promise<string>`

Single-shot question. The simplest possible call. As of batch 1.2 this resolves end-to-end against Anthropic when `ANTHROPIC_API_KEY` is set.

```ts
const summary = await ai.ask("Summarize this:", longText);
```

Two overloads:

- `ai.ask(prompt, options?)` -> the prompt is the entire input.
- `ai.ask(prompt, context, options?)` -> `prompt` is the instruction, `context` is the thing to act on. Traceworks composes them in a sensible order for the chosen model.

#### Image attachments

Every Layer 1 call accepts `attachments: readonly Attachment[]` to send images alongside the prompt. Traceworks handles base64 encoding inside the adapter; you supply raw bytes (a `Uint8Array`, or a Node `Buffer` since `Buffer extends Uint8Array`) and never encode anything by hand.

```ts
import { ai } from "traceworks";
import { readFile } from "node:fs/promises";

const png = await readFile("photo.png");

const description = await ai.ask("Describe this image:", {
  attachments: [
    { kind: "image", source: { type: "base64", data: png, mimeType: "image/png" } },
  ],
});
```

The `Attachment` union is sealed by the `kind` discriminator so future file and document variants land without breaking changes. Today only `kind: "image"` is supported. `ImageSource` is sealed by its own `type` discriminator; `base64` is the only variant shipped today and `mimeType` accepts `image/png`, `image/jpeg`, `image/gif`, or `image/webp`. The adapter places image blocks before the text on the first user message in the request, mirroring Anthropic's vision guidance.

URL-based image sources require an SDK version that is not yet in our peer-dep floor; coming in a future release.

### `ai.chat(messages, options?) -> Promise<string>`

Multi-turn conversation. Pass an array of `{ role, content }` messages.

```ts
const reply = await ai.chat([
  { role: "system", content: "You are a curt RLHF tutor." },
  { role: "user", content: "What is RLHF?" },
]);
```

System routing rule: if a `role: "system"` message is present in the array, its content wins and is routed to the provider's dedicated system channel (Anthropic's top-level `system` field, OpenAI's leading system message). When no in-array system message is present, `options.system` takes effect. The remaining `user` and `assistant` messages forward verbatim. Multiple in-array system messages: the first wins, the rest are dropped.

The same retry, trace, redaction, and timeout pipeline as `ai.ask` applies; `ChatOptions` accepts `model`, `system`, `maxTokens`, `temperature`, `timeoutMs`, `attachments`, and `maxRetries`.

### `ai.extract(schema, input, options?) -> Promise<T>`

Schema-validated extraction. `schema` is any Zod schema; the return type is inferred from it.

```ts
import { z } from "zod";

const Person = z.object({ name: z.string(), email: z.string().email() });
const person = await ai.extract(Person, resumeText);
```

Internally, `ai.extract` builds a system prompt that includes a JSON Schema description of your Zod schema, sends it to the model, parses the response, and validates with `schema.safeParse`. Use `schema.describe("Person")` to give the schema a stable name surfaced in `SchemaValidationError.expectedSchemaName` and the trace.

When the model's response fails validation:

- With `retryOnSchemaFailure: false` (default): throw `SchemaValidationError` with the expected schema name and the actual payload.
- With `retryOnSchemaFailure: true`: retry once, feeding the validation error back to the model as corrective feedback. If the second attempt also fails, throw `SchemaValidationError` carrying the second payload.

#### Supported Zod shapes

The hand-rolled Zod-to-JSON-Schema converter (no extra runtime dependency per the project's dep policy) covers the common shapes:

- `z.string()`, `z.string().email()`, `z.string().url()`, `z.string().uuid()`
- `z.number()`, `z.boolean()`
- `z.literal(v)`, `z.enum([...])`
- `z.array(inner)`
- `z.union([a, b, ...])`
- `z.optional(inner)` (only meaningful inside an object)
- `z.object({ ... })` with nested recursion

Anything outside this subset (records, intersections, transforms, lazy, recursive types) falls back to `{ type: "object" }` so the model still receives a hint. Validation always runs through your real Zod schema, so the runtime contract is whatever Zod accepts; the converter only shapes the system-prompt hint the model sees.

### `ai.stream(prompt, options?) -> AsyncIterable<string>`

Token-by-token streaming. Two consumption modes are supported simultaneously: iterate the returned `AsyncIterable<string>` and/or supply an `onChunk` callback. The callback fires before each chunk yields to the iterator.

```ts
// for-await
for await (const chunk of ai.stream("Write a haiku")) {
  process.stdout.write(chunk);
}

// callback (still iterable; the loop body can be empty)
for await (const _ of ai.stream("Write a haiku", { onChunk: (c) => process.stdout.write(c) })) {
  // no-op; onChunk drives the side effect
}
```

Retry semantics: a failure BEFORE any chunk emits is safe to retry (the consumer has seen nothing) and consults the configured retry strategy exactly like `ai.ask`. A failure AFTER any chunk has already yielded surfaces immediately to the consumer; re-issuing would duplicate output, so mid-stream errors never retry.

The trace record's `usage` is captured at end-of-stream from the provider's final usage event (Anthropic's `message_delta`, OpenAI's terminal usage chunk).

### `ai.agent({ ... }) -> Agent`

The agent factory. See [Agents and tools](agents.md) for the full reference.

## `tool({ ... }) -> RegisteredTool`

The tool factory. See [Agents and tools](agents.md).

## `defineConfig(config) -> TraceworksUserConfig`

Identity helper for `traceworks.config.{ts,mts,js,mjs,cjs}`. Returns its argument unchanged; the value of the helper is the IntelliSense it gives consumers without forcing them to import and annotate the `TraceworksUserConfig` type by hand.

`TraceworksUserConfig` is exported from the package root for users who do prefer explicit annotation:

```ts
import type { TraceworksUserConfig } from "traceworks";

const cfg: TraceworksUserConfig = {
  defaultModel: "claude-sonnet-4-6",
  retry: { maxAttempts: 5 },
};
```

Every field is optional and nested groups (`retry`, `trace`) accept partials, so callers can override one knob without restating its siblings. The full resolution chain (defaults < env < `traceworks.config.*` < per-call) is documented in [Getting started](getting-started.md#project-configuration).

### Per-call `apiKey` override

Every Layer 1 option shape (`AskOptions`, `ChatOptions`, `ExtractOptions`, `StreamOptions`) accepts an `apiKey` field. When supplied it takes precedence over the environment variable AND any provider previously registered via `registerProvider(...)`; the client constructs a fresh adapter for that single call without mutating the registry. Useful for multi-tenant deployments. The trace pipeline scrubs API-key substrings out of every persisted record so the override never lands on disk.

## Errors

Every typed failure derives from `TraceworksError`. See [Troubleshooting](troubleshooting.md) for the full taxonomy.

## Submodules

- `traceworks/agent` - re-exports `agent` and `tool` plus their types. Use this if you only need the agent surface.
- `traceworks/inspect` - exports `TraceRecord`, `TraceSink`, and the inspector startup helper.
- `traceworks/errors` - re-exports the entire error hierarchy. Use this if you only need to catch errors and don't want the full bundle.

## Provider construction (advanced)

Most users never touch the provider classes directly: `ai.ask` resolves a model name to a provider via the registry, and the registry lazy-bootstraps the right adapter from the relevant `<VENDOR>_API_KEY` env var. Power users who need to register a provider explicitly (custom keys, alternate baseURLs, test seams) can construct the adapter themselves.

`AnthropicProvider` / `AnthropicProviderOptions` and `OpenAIProvider` / `OpenAIProviderOptions` ship from the package root so direct construction stays a one-line import:

```ts
import {
  AnthropicProvider,
  type AnthropicProviderOptions,
  OpenAIProvider,
  type OpenAIProviderOptions,
} from "traceworks";

const anthropic = new AnthropicProvider({ apiKey: mySecretManagerLookup("anthropic") });
const openai = new OpenAIProvider({ apiKey: mySecretManagerLookup("openai") });
```

Both option shapes carry two fields today (mirrored intentionally so the two adapters stay diff-friendly):

- `apiKey?: string | undefined` - explicit API key. Omit the field entirely to fall back to `process.env.ANTHROPIC_API_KEY` (Anthropic) or `process.env.OPENAI_API_KEY` (OpenAI). Pass the field with `undefined` explicitly to bypass the env-var read (useful when test code wants to assert the missing-key path on a developer machine that has the var set).
- `fetch?: typeof globalThis.fetch | undefined` - custom `fetch` implementation forwarded to the SDK. Test code injects a fake `fetch` that replays recorded JSON fixtures; production code omits this and the SDK uses the global `fetch`.

Both adapters set the SDK's `maxRetries` to `0` so retry policy stays under Traceworks's control (the client-layer retry loop). Direct adapter callers who want SDK-level retries should construct their own SDK client instead.

The OpenAI adapter routes system instructions through a leading `{ role: "system", content }` message because OpenAI's chat completions API has no top-level `system` field; the Anthropic adapter uses Anthropic's top-level `system` field. The user-facing `ai.ask(..., { system: "..." })` shape is identical across providers; the difference lives behind the adapter boundary.
