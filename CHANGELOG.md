# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.0] - 2026-04-29 - layer 1 + anthropic + openai + minimal trace

### Added

- Repository scaffold: TypeScript project layout, `tsup` build, `vitest` test
  runner, `biome` lint + format, GitHub Actions CI pipeline, issue and PR
  templates, contribution + security + code-of-conduct policies.
- Source-tree skeleton: `src/{client,providers,errors,trace,config,agent,inspect,cli}/`
  with placeholder barrels so the package imports cleanly while Phase 1 lands.
- Public surface placeholder: `ai` namespace exporting typed stubs for `ask`,
  `chat`, `extract`, `stream`, plus the `tool` factory and `defineConfig`
  helper. Runtime behavior arrives in Phase 1.
- `ai.ask()` now calls Anthropic end-to-end against `claude-sonnet-4-6` (default)
  when `ANTHROPIC_API_KEY` is set. Auth, rate-limit, transport, and timeout
  errors map to typed `LimnError` subclasses (`AuthError`, `RateLimitError` with
  `retryAfterMs`, `ProviderError`, `ModelTimeoutError`). The provider registry
  lazy-bootstraps an `AnthropicProvider` from the env var on first use, so
  zero-config code Just Works.
- `AnthropicProvider` constructor now accepts `AnthropicProviderOptions`
  (options-object form) carrying an optional `apiKey` and an optional
  `fetch` override. The `fetch` field forwards to the SDK's documented
  `ClientOptions.fetch` and exists primarily as a test-injection seam:
  unit tests inject a fake `fetch` that replays JSON fixtures from
  `test/fixtures/anthropic/`. Production code passes `apiKey` only (or
  nothing, falling back to the env var).
- `pnpm run verify` now runs `tsc -p tsconfig.test.json --noEmit` so
  `@ts-expect-error` contracts in test files are enforced before CI; the script
  is exposed as `pnpm run typecheck:test` for direct invocation.
- GitHub Actions bumped to versions supporting Node 24 (`actions/checkout@v6`,
  `actions/setup-node@v6`, `pnpm/action-setup@v5`, `codecov/codecov-action@v5`)
  ahead of the 2026-06-02 default-runtime flip.
- Retry policy: every Layer 1 call now flows through an
  `ExponentialBackoffStrategy` consulted between attempts by the
  `HookDispatcher`. `AuthError` never retries; `RateLimitError` honors
  `retryAfterMs` when present and otherwise applies full-jitter exponential
  backoff capped at 30s; retryable `ProviderError` (5xx, transport) backs off
  up to `retry.maxAttempts`; `ModelTimeoutError` retries up to
  `floor(maxAttempts/2)` total attempts. The new `onRetry` lifecycle phase
  fires between attempts (it was declared in batch 1.1 but never invoked
  until this batch). The `HookDispatcher` constructor accepts a
  `HookDispatcherOptions` object (`hooks`, `retry`, `sleepFn`) while still
  supporting the legacy `readonly Hook[]` form for backward compatibility;
  `sleepFn` is the test-injection seam for sleep recording.
- `ProviderError` now carries a `retryable` boolean (default `true`). The
  Anthropic adapter sets `retryable: false` for the bare-`APIError`
  fallthrough (4xx client faults), the `Unexpected Anthropic error` catch-all,
  and the defensive `role: "system"` guard, so the new retry strategy
  rethrows immediately on deterministic failures instead of burning attempts
  on requests that will fail the same way.
- Trace pipeline: every `ai.ask` call now writes one JSON record to
  `.limn/traces/<ulid>.json` via the new `FileSystemTraceSink`. Records
  carry `id`, `timestamp`, `kind`, `model`, `provider`, `latencyMs`,
  `attempts`, `usage`, `request`, `response`, optional `error`, and a
  `redactedFields` array of dot-paths naming every field whose string
  contents had an API-key substring scrubbed. ULID-named files sort
  chronologically without an external index; writes are atomic via
  `tempfile + rename` so partial reads are impossible.
- Key redaction: a new `RedactionHook` runs ahead of the trace hook and
  replaces `sk-ant-`, `sk-proj-`, and `sk-` substrings (with at least 16
  trailing url-safe characters) with `[REDACTED]` in the persisted
  request, response, and error message. Opt out via
  `trace.redactKeys: false` in `limn.config.ts`. Default-on so a key
  smuggled through a prompt or echoed by an SDK error is never persisted
  in plain text.
- `TraceHook` and `RedactionHook` ship as concrete `Hook` implementations
  on top of the batch 1.1 dispatcher; they coordinate via a shared
  per-call `TraceState` object built fresh by the dispatcher factory.
  Sink failures are surfaced via `console.warn` and never crash the
  user's call. Opt out of tracing entirely with `trace.enabled: false`.
- Image attachments: `AskOptions` (and the other Layer 1 option shapes)
  now accept `attachments: readonly Attachment[]`. The new `Attachment`
  union ships with `ImageAttachment` (sealed by a `kind` discriminator
  for future file/document variants); each image carries a sealed
  `ImageSource` (`{ type: "base64", data: Uint8Array, mimeType }`). The
  Anthropic adapter translates attachments into vision content blocks
  on the first user message (images before the text per Anthropic's
  vision guidance), handling base64 encoding internally so the user
  never encodes anything by hand. URL-based image sources require an
  SDK version not yet in our peer-dep floor and will land in a future
  batch as a non-breaking type widening. `Attachment`,
  `ImageAttachment`, `ImageSource`, and `SupportedImageMimeType` are
  re-exported from the package root.
- `ai.chat(messages, options?)` is now wired end-to-end against any
  registered provider. A `role: "system"` message in the array routes to
  the provider's dedicated system channel (Anthropic's top-level `system`
  field; OpenAI's leading system message); when no in-array system message
  is present, `options.system` takes effect. Multi-turn `user` /
  `assistant` history forwards verbatim. Retry, trace, redaction, and
  timeout behavior matches `ai.ask`; the dispatcher records the call as
  `kind: "chat"`.
- `ai.extract(schema, input, options?)` is now wired end-to-end. The flow
  builds a JSON-Schema description of the supplied Zod schema (via a
  hand-rolled converter under `src/extract/zod_to_json_schema.ts`,
  intentionally avoiding a new runtime dependency per the project's dep
  policy), uses it as the system prompt, parses the model response, and
  validates with `schema.safeParse`. Validation failures throw
  `SchemaValidationError` carrying `expectedSchemaName` (read from
  `schema.describe(...)` when present, else the Zod typeName) and
  `actualPayload` (the parsed object or `null` when the response was not
  JSON). With `retryOnSchemaFailure: true` the orchestration appends the
  prior response and the validation message to the conversation and
  re-issues the chat call once; a second failure surfaces the second
  payload via `SchemaValidationError`. The converter supports Zod 3
  primitives, objects (with optional fields), arrays, unions, literals,
  enums, and the common string formats (email, url, uuid); shapes
  outside the subset fall back to a wide `{ type: "object" }` hint.
- `ai.stream(prompt, options?)` is now wired end-to-end. Returns an
  `AsyncIterable<string>` that yields textual deltas as they arrive;
  `options.onChunk` (when supplied) fires once per chunk before the
  iterator yields, so callback-only consumers can drive the stream with
  an empty loop body. The `Provider` interface gained a `requestStream`
  method returning a `{ stream, usage }` pair (the existing throw-only
  `stream` placeholder was removed). The Anthropic adapter consumes the
  SDK's typed event union (`message_start` / `content_block_delta` /
  `message_delta`) and yields `text_delta` payloads; the OpenAI adapter
  reads `choices[0].delta.content` per chunk and reads usage from the
  terminal chunk emitted under `stream_options.include_usage`. The
  `HookDispatcher` gained `runStream`, mirroring `run`'s lifecycle phases
  with stream-aware retry: a failure BEFORE any chunk emits consults the
  retry strategy exactly like a non-streaming call, while a failure
  AFTER any chunk has yielded surfaces immediately (re-issuing would
  duplicate output for the consumer).
- `MockProvider` now scripts streams via `pushStreamChunks(chunks, usage,
  errorAfterChunks?)` and `pushStreamError(err)`, captures requests in
  `streamRequests`, and implements `requestStream` so integration tests
  drive `ai.stream` end-to-end without a network call.
- Project config resolution: every Layer 1 call now resolves its
  effective `LimnConfig` by walking four layers in precedence order
  (defaults < env < `limn.config.*` < per-call options). The new
  `loadProjectConfig` discovers `limn.config.{ts,mts,js,mjs,cjs}` at the
  current working directory via `node:module.createRequire`, caches the
  result for the process lifetime, and surfaces load failures as
  `ConfigLoadError` (new variant) carrying the absolute path. Nested
  groups (`retry`, `trace`) merge per sub-field rather than wholesale,
  so `{ retry: { maxAttempts: 5 } }` overrides only that knob and
  inherits the rest. `LimnUserConfig` is now an explicit shape (rather
  than `Partial<LimnConfig>`) so nested partials type-check, and is
  re-exported from the package root for direct annotation.
- `LIMN_TRACE_DIR` env var now overrides `trace.dir` in the resolution
  chain. Other `LIMN_*` vars are intentionally unrecognized: new env
  surface must add a switch arm in `envOverridesFromProcess` AND
  document itself in `guides/getting-started.md` so the contract stays
  explicit.
- Per-call `apiKey` override on every Layer 1 option shape
  (`AskOptions`, `ChatOptions`, `ExtractOptions`, `StreamOptions`).
  When supplied, the client constructs a fresh provider adapter for
  that single call WITHOUT touching the registry's cached slot, so
  adjacent calls keep using the registered (or lazily-bootstrapped)
  provider unchanged. The canonical use case is multi-tenant
  deployment: each request carries the tenant's key without racing on
  shared mutable state. The trace redactor scrubs the key out of the
  persisted request and response.
- `ConfigLoadError` variant joins the `LimnError` hierarchy. Carries
  the absolute path to the offending config file plus the original
  error on `cause`. Recovery: fix the syntax/import error, or rename
  the file to disable discovery while debugging.
- `resolveProvider(name, perCallApiKey?)` helper on the registry: the
  one-line entry point the client uses to swap the cached provider
  for a per-call adapter when `apiKey` is supplied.
- OpenAI provider adapter wraps `openai`'s chat completions API and
  mirrors the Anthropic adapter shape one-to-one: lazy SDK import,
  cached client + error-class table, fetch-injection seam for tests,
  same `AbortController` timeout enforcement, same
  `AuthError` / `RateLimitError(retryAfterMs)` / `ProviderError` /
  `ModelTimeoutError` mapping. `ai.ask("hi", { model: "gpt-4o-mini" })`
  now resolves end-to-end against OpenAI when `OPENAI_API_KEY` is set;
  the registry lazy-bootstraps an `OpenAIProvider` from the env var on
  first use. System instructions ride as a leading
  `{ role: "system", content }` message (OpenAI's chat completions API
  has no top-level `system` field). Image attachments translate to
  `image_url` content parts with a `data:<mime>;base64,<...>` URI,
  placed before the text on the first user message; URL-form image
  sources await the same SDK-floor bump that gates Anthropic's URL
  variant. Streaming is deferred to batch 1.7. `OpenAIProvider` and
  `OpenAIProviderOptions` are re-exported from the package root for
  direct construction.

### Changed

- `Provider` interface: replaced `stream(req): AsyncIterable<string>` with
  `requestStream(req): { stream, usage }`. The two-channel shape lets the
  dispatcher consume token-by-token deltas via the `stream` channel and
  capture usage tokens at end-of-stream via the `usage` promise without
  squeezing a sentinel into the chunk type. Both shipped adapters
  implement the new method; the previous placeholder `stream` arms (which
  always threw "not implemented yet (batch 1.7)") are removed. No public
  consumers of the old method existed.
- Replaced `vi.mock("@anthropic-ai/sdk")` in the Anthropic adapter unit
  tests with a fake-`fetch` injection that replays recorded JSON fixtures
  through the real SDK. The SDK runs unmodified, so its real error
  classes (`AuthenticationError`, `RateLimitError`, etc.) construct from
  real HTTP status codes and the adapter's `instanceof` mapping is
  exercised against the real class hierarchy. Fixture files live in
  `test/fixtures/anthropic/` and document the mapping from status code
  to `LimnError` variant. The SDK's built-in `maxRetries` is now set to
  `0` from the adapter so retry policy stays under Limn's control.
- Anthropic adapter cached SDK state collapsed into a single atomic field;
  SDK-boundary cast narrowed to a structural method shape (no `any` left
  in the adapter); `AnthropicProvider` + `AnthropicProviderOptions` now
  re-exported from the package root. Fake-fetch test helper extracted to
  `test/_helpers/fake_fetch.ts` for reuse by the OpenAI adapter (batch 1.6).
- `ImageSource.data` is now typed as `Uint8Array` (Node's `Buffer` still
  works because `Buffer extends Uint8Array`). The Anthropic adapter now
  base64-encodes attachments via `Buffer.from(bytes).toString("base64")`
  so a raw `Uint8Array` is accepted on Node without forcing callers to
  wrap their bytes in a `Buffer`.

### Fixed

- Trace pipeline now replaces `Buffer` / `Uint8Array` payloads with a
  `{ kind: "binary", byteLength }` placeholder in the redactor's deep
  walk. Previously the walker fell into the generic object branch and
  enumerated every indexed numeric property of the buffer, bloating a
  100KB image into a multi-megabyte JSON file (~9-11x). The substitution
  is intentionally lossy: image bytes carry no information the
  inspector can render anyway, and the path of every substitution is
  recorded in `redactedFields` so consumers can grep for binary
  attachments. With trace on by default, this fix turns image-bearing
  calls from a CPU + disk hazard into a fixed-cost trace.
- Hook context no longer leaks the prior failed attempt's `error` into
  `onCallSuccess`/`onCallEnd` after a successful retry recovery. The
  dispatcher now strips `error` and `response` at the top of each retry
  iteration so each phase sees only its own contract-relevant fields.
- Redactor walker now guards against cyclic input via a per-call
  `WeakMap` (original to clone), so a self-referential request payload
  no longer stack-overflows the trace pipeline. The cleaned tree mirrors
  the input's topology including cycles.
- Trace sink-failure warning now includes the trace ID for correlation:
  `[limn] trace sink "FileSystemTraceSink" failed to write trace
  trc_<uuid>: <error>`.
- Removed dead `attempt` field from `TraceState`; `TraceHook.onCallEnd`
  now reads `ctx.attempt` directly from the dispatcher's `HookContext`,
  eliminating the duplicated source of truth for the attempt counter.

### Notes

- Pre-1.0. Public API is in active design; expect breaking changes between
  every minor release until the v1.0.0 stability commitment.
- `ai.extract(retryOnSchemaFailure: true)` produces two independent trace
  records (one per chat attempt). Inspector linkage between sibling
  attempts is deferred to Phase 2.

[Unreleased]: https://github.com/CanArslanDev/limn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CanArslanDev/limn/releases/tag/v0.1.0
