# API surface reference

Every public function and type that ships from `limn`. The README has the 5-minute tour; this is the long form.

> Phase 1 is in flight. `ai.ask` is live against Anthropic as of batch 1.2; `ai.chat`, `ai.extract`, and `ai.stream` remain placeholders until their batches land.

## `ai` namespace

### `ai.ask(prompt, options?) -> Promise<string>`

Single-shot question. The simplest possible call. As of batch 1.2 this resolves end-to-end against Anthropic when `ANTHROPIC_API_KEY` is set.

```ts
const summary = await ai.ask("Summarize this:", longText);
```

Two overloads:

- `ai.ask(prompt, options?)` -> the prompt is the entire input.
- `ai.ask(prompt, context, options?)` -> `prompt` is the instruction, `context` is the thing to act on. Limn composes them in a sensible order for the chosen model.

#### Image attachments

Every Layer 1 call accepts `attachments: readonly Attachment[]` to send images alongside the prompt. Limn handles base64 encoding inside the adapter; you supply raw bytes (a `Uint8Array`, or a Node `Buffer` since `Buffer extends Uint8Array`) and never encode anything by hand.

```ts
import { ai } from "limn";
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

If a `role: "system"` message is present in the array, it wins over `options.system`.

### `ai.extract(schema, input, options?) -> Promise<T>`

Schema-validated extraction. `schema` is any Zod schema; the return type is inferred from it.

```ts
import { z } from "zod";

const Person = z.object({ name: z.string(), email: z.string().email() });
const person = await ai.extract(Person, resumeText);
```

When the model's response fails validation:

- With `retryOnSchemaFailure: false` (default): throw `SchemaValidationError` with the expected schema name and the actual payload.
- With `retryOnSchemaFailure: true`: retry once, feeding the validation error back to the model as corrective feedback.

### `ai.stream(prompt, options?) -> AsyncIterable<string>`

Token-by-token streaming. Two consumption modes simultaneously:

```ts
// for-await
for await (const chunk of ai.stream("Write a haiku")) {
  process.stdout.write(chunk);
}

// callback (still iterable)
ai.stream("Write a haiku", { onChunk: (c) => process.stdout.write(c) });
```

### `ai.agent({ ... }) -> Agent`

The agent factory. See [Agents and tools](agents.md) for the full reference.

## `tool({ ... }) -> RegisteredTool`

The tool factory. See [Agents and tools](agents.md).

## `defineConfig(config) -> LimnUserConfig`

Identity helper for `limn.config.ts`. Lets you get full IntelliSense without manually annotating the type.

## Errors

Every typed failure derives from `LimnError`. See [Troubleshooting](troubleshooting.md) for the full taxonomy.

## Submodules

- `limn/agent` - re-exports `agent` and `tool` plus their types. Use this if you only need the agent surface.
- `limn/inspect` - exports `TraceRecord`, `TraceSink`, and the inspector startup helper.
- `limn/errors` - re-exports the entire error hierarchy. Use this if you only need to catch errors and don't want the full bundle.

## Provider construction (advanced)

Most users never touch the provider classes directly: `ai.ask` resolves a model name to a provider via the registry, and the registry lazy-bootstraps the right adapter from the relevant `<VENDOR>_API_KEY` env var. Power users who need to register a provider explicitly (custom keys, alternate baseURLs, test seams) can construct the adapter themselves.

`AnthropicProvider` / `AnthropicProviderOptions` and `OpenAIProvider` / `OpenAIProviderOptions` ship from the package root so direct construction stays a one-line import:

```ts
import {
  AnthropicProvider,
  type AnthropicProviderOptions,
  OpenAIProvider,
  type OpenAIProviderOptions,
} from "limn";

const anthropic = new AnthropicProvider({ apiKey: mySecretManagerLookup("anthropic") });
const openai = new OpenAIProvider({ apiKey: mySecretManagerLookup("openai") });
```

Both option shapes carry two fields today (mirrored intentionally so the two adapters stay diff-friendly):

- `apiKey?: string | undefined` - explicit API key. Omit the field entirely to fall back to `process.env.ANTHROPIC_API_KEY` (Anthropic) or `process.env.OPENAI_API_KEY` (OpenAI). Pass the field with `undefined` explicitly to bypass the env-var read (useful when test code wants to assert the missing-key path on a developer machine that has the var set).
- `fetch?: typeof globalThis.fetch | undefined` - custom `fetch` implementation forwarded to the SDK. Test code injects a fake `fetch` that replays recorded JSON fixtures; production code omits this and the SDK uses the global `fetch`.

Both adapters set the SDK's `maxRetries` to `0` so retry policy stays under Limn's control (the client-layer retry loop). Direct adapter callers who want SDK-level retries should construct their own SDK client instead.

The OpenAI adapter routes system instructions through a leading `{ role: "system", content }` message because OpenAI's chat completions API has no top-level `system` field; the Anthropic adapter uses Anthropic's top-level `system` field. The user-facing `ai.ask(..., { system: "..." })` shape is identical across providers; the difference lives behind the adapter boundary.
