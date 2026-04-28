# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

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
- `ProviderError` now carries a `retryable` boolean (default `true`). The
  Anthropic adapter sets `retryable: false` for the bare-`APIError`
  fallthrough (4xx client faults), the `Unexpected Anthropic error` catch-all,
  and the defensive `role: "system"` guard, so the new retry strategy
  rethrows immediately on deterministic failures instead of burning attempts
  on requests that will fail the same way.

### Notes

- Pre-1.0. Public API is in active design; expect breaking changes between
  every minor release until the v1.0.0 stability commitment.

[Unreleased]: https://github.com/CanArslanDev/limn/compare/HEAD...HEAD
