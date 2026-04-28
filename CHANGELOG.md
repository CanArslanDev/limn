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

### Changed

- Replaced `vi.mock("@anthropic-ai/sdk")` in the Anthropic adapter unit
  tests with a fake-`fetch` injection that replays recorded JSON fixtures
  through the real SDK. The SDK runs unmodified, so its real error
  classes (`AuthenticationError`, `RateLimitError`, etc.) construct from
  real HTTP status codes and the adapter's `instanceof` mapping is
  exercised against the real class hierarchy. Fixture files live in
  `test/fixtures/anthropic/` and document the mapping from status code
  to `LimnError` variant. The SDK's built-in `maxRetries` is now set to
  `0` from the adapter so retry policy stays under Limn's control
  (deferred to batch 1.4).

### Notes

- Pre-1.0. Public API is in active design; expect breaking changes between
  every minor release until the v1.0.0 stability commitment.

[Unreleased]: https://github.com/CanArslanDev/limn/compare/HEAD...HEAD
