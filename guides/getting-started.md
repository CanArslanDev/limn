# Getting started

This guide walks you from `npm install traceworks` to your first working LLM call. It covers installation, provider keys, configuration, the simplest call, retries, and where to go next.

## Install

Traceworks requires Node.js 20.10 or newer.

```bash
pnpm add traceworks
# or
npm install traceworks
# or
yarn add traceworks
```

The Anthropic and OpenAI SDKs are listed as optional peer dependencies. Install whichever providers you intend to use:

```bash
pnpm add @anthropic-ai/sdk
pnpm add openai
```

If you call a model whose provider SDK is not installed, Traceworks throws a clear `ProviderError` at request time pointing at the missing package.

## Configure provider keys

Traceworks reads keys from environment variables by default:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

As of batch 1.2 the Anthropic adapter is wired end-to-end and as of batch 1.6 the OpenAI adapter is too: the first time your code calls `ai.ask` (or any future Layer 1 entry point) without an explicitly registered provider, Traceworks lazily constructs an `AnthropicProvider` (when the chosen model is an Anthropic model) or an `OpenAIProvider` (when it is an OpenAI model) reading `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from `process.env` accordingly. If the relevant env var is missing, the call rejects with an `AuthError` naming the variable to set rather than a generic "not registered" error. The retry policy, trace pipeline, attachments, and timeout controls described elsewhere on this page apply identically to both providers.

You can also set keys in `traceworks.config.ts` (see below) or pass them per call. The local-first trace pipeline never persists keys to disk; they live in process memory only.

## Your first call

```ts
import { ai } from "traceworks";

const summary = await ai.ask("Summarize this:", longText);
```

That's it. With zero configuration, Traceworks:

- Picks a sensible default model (`claude-sonnet-4-6`).
- Retries up to 3 times with exponential backoff on rate-limit and transient errors.
- Times out at 60 seconds.
- Writes a JSON trace record to `.traceworks/traces/<ulid>.json` with API keys
  redacted out of the persisted request, response, and error message.

## Sending images

Pass an `attachments` array on any Layer 1 call to send an image alongside the prompt. Traceworks handles base64 encoding inside the Anthropic adapter, so you supply raw bytes as a `Uint8Array`. A Node `Buffer` works directly because `Buffer extends Uint8Array`.

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

Multiple images attach in order; they appear before the prompt text on the request the provider sees. See [API surface reference](api-surface.md) for the full `Attachment` union and the `image/png` / `image/jpeg` / `image/gif` / `image/webp` MIME types accepted today.

Image attachments today require a Node runtime: the adapter routes bytes through `Buffer.from(...)` to base64-encode them. Edge and browser portability is part of the broader Traceworks portability story and is tracked separately. URL-based image sources also live in a future batch (the pinned Anthropic SDK floor does not declare them yet).

## Tracing

Every Layer 1 call lands as one JSON file under `trace.dir` (default
`.traceworks/traces/`). The file name is a ULID so directory listings sort
chronologically; the JSON body carries the trace `id` (a stable
`trc_<uuid>`), an ISO 8601 `timestamp`, the resolved `model`, `provider`,
`latencyMs`, the final `attempts` count, token `usage`, the
provider-agnostic `request` and `response`, an optional `error`, and a
`redactedFields` array.

Redaction is on by default. The hook scrubs `sk-ant-`, `sk-proj-`, and
`sk-` substrings (at least 16 trailing url-safe characters) and replaces
them with `[REDACTED]`. Each modified field surfaces in `redactedFields`
as a dot-path locator (for example `request.messages.0.content`) so the
inspector can show what was scrubbed without leaking the secret itself.

Two opt-outs:

- `trace.enabled: false` skips the trace pipeline entirely. Calls run
  with retry only; no files are written.
- `trace.redactKeys: false` keeps tracing on but persists raw payloads.
  Not recommended; only useful when debugging the redactor itself.

Trace files are local-only. Traceworks never sends them anywhere; the inspector
(Phase 2) reads the same directory.

## Project configuration

For project-wide overrides, create `traceworks.config.ts` (or `.js`, `.mjs`, `.cjs`) at your project root:

```ts
import { defineConfig } from "traceworks";

export default defineConfig({
  defaultModel: "claude-opus-4-7",
  retry: { maxAttempts: 5, backoff: "exponential", initialDelayMs: 1_000 },
  trace: { enabled: true, dir: ".traceworks/traces", redactKeys: true },
  timeoutMs: 120_000,
});
```

Traceworks discovers the file via `node:module.createRequire` from the current working directory. The first match wins in this extension order: `.ts`, `.mts`, `.js`, `.mjs`, `.cjs`. The result is cached for the process lifetime so a long-running server reads the file exactly once.

TypeScript configs (`.ts`, `.mts`) require a runtime that understands TypeScript: `tsx`, `ts-node`, or Node 22+ with `--experimental-strip-types`. Without such a loader Node raises a `SyntaxError` and Traceworks surfaces it as a `ConfigLoadError` carrying the absolute path. If your runtime does not have a TypeScript loader, ship `traceworks.config.js` instead and annotate it via JSDoc:

```js
// traceworks.config.js
import { defineConfig } from "traceworks";

/** @type {import("traceworks").TraceworksUserConfig} */
export default defineConfig({
  defaultModel: "claude-opus-4-7",
  trace: { dir: ".traceworks/traces" },
});
```

Nested groups (`retry`, `trace`) accept partials: setting `{ retry: { maxAttempts: 5 } }` overrides only that knob and inherits `backoff` and `initialDelayMs` from the lower layer.

Resolution order (later overrides earlier):

1. Built-in defaults.
2. Environment variables (currently `TRACEWORKS_TRACE_DIR`; provider keys `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are read by the registry directly, not by the config layer).
3. `traceworks.config.ts` (or `.js` / `.mjs` / `.cjs`) at the project root.
4. Per-agent options (`ai.agent({ ... })`).
5. Per-call options (`ai.ask(prompt, { ... })`).

Concrete example: `defaultModel` in the call beats `defaultModel` in the file beats `defaultModel` from the env beats the built-in `claude-sonnet-4-6` default. `trace.dir` from the file overrides the env-var override which in turn overrides the `.traceworks/traces` default. Higher layers do NOT need to repeat lower-layer fields; absent fields fall through.

Most users only touch the first three layers.

### Per-call API key override

Every Layer 1 option shape (`AskOptions`, `ChatOptions`, `ExtractOptions`, `StreamOptions`) accepts an `apiKey` field that takes precedence over the environment variable AND any provider previously registered via `registerProvider(...)`:

```ts
const summary = await ai.ask("Summarize this:", longText, {
  apiKey: process.env.TENANT_KEY,
});
```

The canonical use case is multi-tenant deployment: a single server handles requests from many end-users, each authenticating as a different tenant. Passing the per-tenant key on the call rather than mutating the registry keeps tenants isolated; the client constructs a fresh adapter for THIS call only and does not persist the key anywhere. The trace pipeline scrubs API-key substrings out of every persisted request and response, so the override never lands on disk.

## Retries and rate limits

Every provider call is wrapped in a retry loop honoring `Retry-After` headers from the provider. The default is full-jitter exponential backoff up to 3 attempts (capped at 30 seconds per delay); tune via `retry: { maxAttempts, backoff, initialDelayMs }`. Set `backoff: "linear"` for a constant `initialDelayMs` between attempts (no jitter) or `backoff: "none"` to disable computed-backoff retries entirely (`RateLimitError.retryAfterMs` is still honored when the provider supplies it).

Per-error-type policy on the default strategy:

- `AuthError`: never retries. A bad key never becomes good by waiting.
- `RateLimitError`: honors `retryAfterMs` when the provider supplies it; otherwise computed backoff. Capped at `retry.maxAttempts`.
- `ProviderError` with `retryable: true` (5xx, transport): exponential backoff up to `retry.maxAttempts`. Deterministic 4xx faults carry `retryable: false` and surface immediately.
- `ModelTimeoutError`: retries only when `retry.maxAttempts >= 4`. The cap is `floor(maxAttempts / 2)` total attempts and a `ModelTimeoutError` surfaces once `attempt >= cap`, so with the default `maxAttempts: 3` the cap is `1` and the first timeout surfaces immediately. Bump `retry.maxAttempts` if you want any timeout retry budget; timeouts are usually deterministic so the policy halves the budget by design.
- `SchemaValidationError`: not transport-level; retried by `ai.extract` only when `retryOnSchemaFailure: true` is set on the call.

## The other Layer 1 entry points

`ai.ask` is the simplest call. The other three round out Layer 1:

```ts
import { ai } from "traceworks";
import { z } from "zod";

// Multi-turn conversation
const reply = await ai.chat([
  { role: "system", content: "You are a curt RLHF tutor." },
  { role: "user", content: "What is RLHF?" },
]);

// Schema-validated extraction
const Person = z.object({ name: z.string(), email: z.string().email() });
const person = await ai.extract(Person, resumeText);

// Token-by-token streaming
for await (const chunk of ai.stream("Write a haiku")) {
  process.stdout.write(chunk);
}
```

All four entry points share the same retry, trace, and timeout pipeline. See [API surface reference](api-surface.md) for the full options.

## Where to go next

- [API surface reference](api-surface.md) for the full list of functions on `ai`.
- [Cookbook](cookbook.md) for copy-paste patterns.
- [Agents and tools](agents.md) for multi-turn loops.
- [Inspector](inspect.md) for the local debug UI.
- [Troubleshooting](troubleshooting.md) for the error taxonomy.
