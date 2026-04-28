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
