# Limn

> An AI-native TypeScript library for building, debugging, and operating LLM applications. Limn your AI.

[![npm](https://img.shields.io/npm/v/limn?label=npm)](https://www.npmjs.com/package/limn)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.10-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-%E2%89%A5%205.6-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Limn is a single TypeScript library that makes the easy LLM things easy, the hard things possible, and observability free by default. It wraps Anthropic and OpenAI behind one ergonomic surface, treats agents and tool use as first-class, and ships a local trace pipeline so every call is debuggable from the moment you install it.

No service to sign up for. No separate observability product to wire in. No framework to commit to. Just `npm install limn`.

## Why

Building LLM apps today means stitching three or four independent libraries together: the SDK, an agent layer, an observability platform, and a scaffolding tool. Limn collapses that surface area into a single import with shared types and a shared trace pipeline, so the simplest call is one line and a five-line program already has full tracing, retries, and clear error messages.

## Features

- **Three-layer API surface.** Layer 1: single-shot `ai.ask` / `ai.chat` / `ai.extract` / `ai.stream`. Layer 2: `ai.agent({ model, tools, onError })` for tool use and multi-turn loops. Layer 3: local `npx limn inspect` debug UI reading from `.limn/traces/` JSON.
- **Provider-agnostic core.** Anthropic and OpenAI on day one, abstracted behind one client. Pick a model name; Limn picks the right SDK.
- **Typed errors with documented recovery paths.** `RateLimitError`, `SchemaValidationError`, `ToolExecutionError`, `ModelTimeoutError`, `AuthError`, `ProviderError`. No silent failures, no opaque stack traces.
- **Streaming is first-class.** Every generation function has a streaming counterpart. Same API surface; no separate "streaming SDK".
- **Structured extraction.** `ai.extract(schema, input)` validates the model's response against a Zod schema and surfaces a side-by-side expected-vs-actual diff in the inspector if it fails.
- **Tool use with end-to-end types.** `tool({ name, description, input, run })` gives the model an input schema and your callback a typed argument. Malformed tool input is caught, surfaced clearly, and (optionally) retried with corrective feedback.
- **Local-first observability.** Every call writes a structured JSON record to `.limn/traces/` by default. No telemetry, no account, no network calls beyond the LLM provider.
- **Zero-config defaults that work.** A user who writes `await ai.ask("...")` gets a sensible model, sensible timeouts, sensible retries, without configuration. Configuration is hierarchical: global `limn.config.ts` -> per-agent -> per-call.
- **Strict TypeScript.** Sealed error hierarchy, branded model names, no magic strings, full type inference end-to-end. `any` is banned outside the provider boundary.
- **Single import path.** Everything ships from `limn`. Submodules (`limn/agent`, `limn/inspect`, `limn/errors`) exist for tree-shaking but are optional.

## Install

```bash
npm install limn
# or
pnpm add limn
# or
yarn add limn
```

The package is pre-publication; until the first tagged release lands on npm, depend on the GitHub commit:

```bash
npm install github:CanArslanDev/limn
```

Set your provider keys via environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), via `limn.config.ts`, or per call. See [`guides/getting-started.md`](guides/getting-started.md) for the full configuration walkthrough.

## Detailed documentation

This README is the 5-minute tour. For deeper material, see [`guides/`](guides/):

- [`guides/getting-started.md`](guides/getting-started.md): install, configuration, first call, data + retries.
- [`guides/api-surface.md`](guides/api-surface.md): full reference for `ai.ask`, `ai.chat`, `ai.extract`, `ai.stream`, `ai.agent`, `tool`.
- [`guides/cookbook.md`](guides/cookbook.md): copy-paste recipes for common patterns.
- [`guides/agents.md`](guides/agents.md): agents, tools, multi-turn loops, error handlers.
- [`guides/inspect.md`](guides/inspect.md): the local debug UI, trace format, replay.
- [`guides/troubleshooting.md`](guides/troubleshooting.md): error taxonomy, common failure modes, recovery paths.

## Quickstart

```ts
import { ai } from "limn";

// Single-shot question
const summary = await ai.ask("Summarize this:", longText);

// Conversation
const reply = await ai.chat([
  { role: "user", content: "What is RLHF?" },
]);

// Structured extraction
import { z } from "zod";

const PersonSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  yearsOfExperience: z.number().int().nonnegative(),
});

const person = await ai.extract(PersonSchema, resumeText);

// Streaming
for await (const chunk of ai.stream("Write a poem about debugging")) {
  process.stdout.write(chunk);
}
```

A runnable version lives in [`examples/`](examples/).

## Agents and tools

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

Tool inputs are typed end-to-end. If the model returns malformed JSON or argues with the schema, Limn surfaces a `SchemaValidationError` with the expected schema, the actual payload, and an optional automatic retry that feeds the model corrective feedback.

## Local inspector

Every call from the simple API and the agent layer writes a structured JSON record to `.limn/traces/`. To browse them locally:

```bash
npx limn inspect
# opens localhost:3000
```

The local UI shows: every prompt sent, every response received, every tool call, token usage, cost breakdown, latency per step, and a side-by-side "expected vs. actual" view when schema extraction fails. Local-only by default; no telemetry, no account, no upload.

## Configuration

Limn reads configuration in this order (later overrides earlier):

1. Built-in defaults.
2. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LIMN_TRACE_DIR`, `LIMN_DEFAULT_MODEL`, ...).
3. `limn.config.ts` at the project root, if present.
4. Per-agent options passed to `ai.agent({ ... })`.
5. Per-call options passed to `ai.ask(prompt, { ... })` and friends.

```ts
// limn.config.ts
import { defineConfig } from "limn";

export default defineConfig({
  defaultModel: "claude-sonnet-4-6",
  retry: { maxAttempts: 3, backoff: "exponential" },
  trace: { dir: ".limn/traces", enabled: true },
});
```

## Architecture

A unidirectional pipeline:

```
ai (public surface)  ->  Client  ->  Provider abstraction  ->  Anthropic | OpenAI SDK
                          |
                          v
                       Trace pipeline  ->  .limn/traces/*.json  ->  npx limn inspect
                          |
                          v
                       Agent loop  ->  Tool dispatch  ->  Schema validation
```

Architecture invariants (imports flow downward only) are enforced by `test/architecture/import_flow_test.ts`.

## Roadmap

| Phase | Scope                                                | Target |
| ----- | ---------------------------------------------------- | ------ |
| 0     | Reserve names, scaffold repo, CI, placeholder npm    | done   |
| 1     | Layer 1 + minimal trace JSON on disk                 | next   |
| 2     | `npx limn inspect` local debug UI                    |        |
| 3     | Agents + tools + typed multi-turn loops              |        |
| 4     | `npx limn init` CLI templates                        |        |
| 5     | Hosted observability (opt-in)                        |        |

The full plan lives in [`idea.md`](idea.md) (local only) and the per-phase plan documents under `docs/superpowers/plans/` (local only).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development setup, style guide, testing discipline (TDD), and PR checklist. The short version: every new behavior ships with a failing-then-passing test in the same commit; lint + typecheck + test stay green on `main` at every commit.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model, supported versions, and how to report a vulnerability privately. Do not open public GitHub issues for security reports.

## License

MIT. See [`LICENSE`](LICENSE).

## Support

If Limn helps your project, [buy me a coffee](https://buymeacoffee.com/canarslandev). Issue triage and feature work both run on caffeine.
