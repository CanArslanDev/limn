# Agents and tools

Limn's agent layer lives on top of Layer 1. Same client, same configuration, same trace pipeline.

> Phase 3 placeholder. The runtime arrives once Layer 1 + the inspector are stable.

## The shape

```ts
import { ai, tool } from "limn";
import { z } from "zod";

const search = tool({
  name: "search",
  description: "Search the web",
  input: z.object({ query: z.string() }),
  run: async ({ query }) => fetch(`https://api.example.com/search?q=${query}`).then((r) => r.json()),
});

const agent = ai.agent({
  model: "claude-opus-4-7",
  tools: [search],
  onError: { RateLimitError: { retry: "exponential", max: 3 } },
});

const result = await agent.run("Research recent advances in RLHF");
```

## `tool({ name, description, input, run })`

The tool factory. `input` is a Zod schema that doubles as:

- A JSON-Schema document fed to the provider so the model knows what shape to produce.
- A runtime validator that parses model-supplied input before calling `run`.

If the model returns malformed input, Limn throws `SchemaValidationError` with the expected schema and the actual payload. With `onError: { SchemaValidationError: { retry: "once" } }`, the agent retries with the validation message fed back to the model as corrective feedback.

## `ai.agent({ ... })`

Options:

- `model: ModelName` - the model to use for every turn. Required.
- `tools?: readonly RegisteredTool[]` - the tools the model can call.
- `system?: string` - system instruction shared across every turn.
- `maxTurns?: number` - hard cap on the loop. Default 10.
- `onError?: AgentErrorHandlers` - per-error-variant retry policy.

Returns an `Agent` with a single method: `run(prompt) -> Promise<AgentResult>`. The result carries `output`, `turns`, and `traceId` so you can jump to the trace in the inspector.

## Error handling

Every typed Limn error can have a per-agent retry policy:

```ts
ai.agent({
  model: "claude-opus-4-7",
  tools: [search],
  onError: {
    RateLimitError: { retry: "exponential", max: 3 },
    ToolExecutionError: { retry: "once" },
    SchemaValidationError: { retry: "once" },
  },
});
```

`AuthError` and `ProviderError` (5xx) never auto-retry: they are surface-to-the-user errors.

## Streaming agent output

A streaming counterpart lands alongside the non-streaming one. The shape:

```ts
for await (const event of agent.stream("Research RLHF")) {
  // event is { type: "token", chunk } | { type: "tool_call", name, input } | ...
}
```

Tool calls and tokens interleave in a single stream so UI code can render both in real time.

## What's not in scope

Limn's agent layer deliberately omits:

- Multi-agent orchestration (use a workflow tool if you need it; or open an issue if you'd like to discuss a built-in shape).
- Built-in memory / vector stores (leave that choice to the user).
- First-party tools (search, browser, etc.). The factory is the contract; the tools are yours.

The plan is sequencing: Layer 1 must be excellent, then the inspector, then agents. Anything beyond that is driven by user feedback, not roadmap commitment.
