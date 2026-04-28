# Getting started

This guide walks you from `npm install limn` to your first working LLM call. It covers installation, provider keys, configuration, the simplest call, retries, and where to go next.

## Install

Limn requires Node.js 20.10 or newer.

```bash
pnpm add limn
# or
npm install limn
# or
yarn add limn
```

The Anthropic and OpenAI SDKs are listed as optional peer dependencies. Install whichever providers you intend to use:

```bash
pnpm add @anthropic-ai/sdk
pnpm add openai
```

If you call a model whose provider SDK is not installed, Limn throws a clear `ProviderError` at request time pointing at the missing package.

## Configure provider keys

Limn reads keys from environment variables by default:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

As of batch 1.2 the Anthropic adapter is wired end-to-end: the first time your code calls `ai.ask` (or any future Layer 1 entry point) without an explicitly registered provider, Limn lazily constructs an `AnthropicProvider` that reads `ANTHROPIC_API_KEY` from `process.env`. If the env var is missing, the call rejects with an `AuthError` naming the variable to set rather than a generic "not registered" error.

You can also set keys in `limn.config.ts` (see below) or pass them per call. The local-first trace pipeline never persists keys to disk; they live in process memory only.

## Your first call

```ts
import { ai } from "limn";

const summary = await ai.ask("Summarize this:", longText);
```

That's it. With zero configuration, Limn:

- Picks a sensible default model (`claude-sonnet-4-6`).
- Retries up to 3 times with exponential backoff on rate-limit and transient errors.
- Times out at 60 seconds.
- Writes a JSON trace record to `.limn/traces/<ulid>.json` with API keys
  redacted out of the persisted request, response, and error message.

## Tracing

Every Layer 1 call lands as one JSON file under `trace.dir` (default
`.limn/traces/`). The file name is a ULID so directory listings sort
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

Trace files are local-only. Limn never sends them anywhere; the inspector
(Phase 2) reads the same directory.

## Project configuration

For project-wide overrides, create `limn.config.ts` at your project root:

```ts
import { defineConfig } from "limn";

export default defineConfig({
  defaultModel: "claude-opus-4-7",
  retry: { maxAttempts: 5, backoff: "exponential", initialDelayMs: 1_000 },
  trace: { enabled: true, dir: ".limn/traces", redactKeys: true },
  timeoutMs: 120_000,
});
```

Resolution order (later overrides earlier):

1. Built-in defaults.
2. Environment variables.
3. `limn.config.ts`.
4. Per-agent options (`ai.agent({ ... })`).
5. Per-call options (`ai.ask(prompt, { ... })`).

Most users only touch the first three layers.

## Retries and rate limits

Every provider call is wrapped in a retry loop honoring `Retry-After` headers from the provider. The default is full-jitter exponential backoff up to 3 attempts (capped at 30 seconds per delay); tune via `retry: { maxAttempts, backoff, initialDelayMs }`. Set `backoff: "linear"` for a constant `initialDelayMs` between attempts (no jitter) or `backoff: "none"` to disable computed-backoff retries entirely (`RateLimitError.retryAfterMs` is still honored when the provider supplies it).

Per-error-type policy on the default strategy:

- `AuthError`: never retries. A bad key never becomes good by waiting.
- `RateLimitError`: honors `retryAfterMs` when the provider supplies it; otherwise computed backoff. Capped at `retry.maxAttempts`.
- `ProviderError` with `retryable: true` (5xx, transport): exponential backoff up to `retry.maxAttempts`. Deterministic 4xx faults carry `retryable: false` and surface immediately.
- `ModelTimeoutError`: retries only when `retry.maxAttempts >= 4`. The cap is `floor(maxAttempts / 2)` total attempts and a `ModelTimeoutError` surfaces once `attempt >= cap`, so with the default `maxAttempts: 3` the cap is `1` and the first timeout surfaces immediately. Bump `retry.maxAttempts` if you want any timeout retry budget; timeouts are usually deterministic so the policy halves the budget by design.
- `SchemaValidationError`: not transport-level; retried by `ai.extract` only when `retryOnSchemaFailure: true` is set on the call.

## Where to go next

- [API surface reference](api-surface.md) for the full list of functions on `ai`.
- [Cookbook](cookbook.md) for copy-paste patterns.
- [Agents and tools](agents.md) for multi-turn loops.
- [Inspector](inspect.md) for the local debug UI.
- [Troubleshooting](troubleshooting.md) for the error taxonomy.
