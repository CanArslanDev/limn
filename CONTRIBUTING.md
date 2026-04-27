# Contributing to Limn

Thanks for your interest in contributing. This guide covers what you need to know to work on Limn productively.

## Project overview

Limn is a TypeScript-first library that wraps Anthropic and OpenAI behind one ergonomic surface, treats agents and tool use as first-class, and ships a local trace pipeline so every call is debuggable from `npm install`. It is a library, not a framework: users call our code; we do not call theirs. Optional CLI scaffolding lives behind `npx limn init` but is never required.

## Getting started

- Clone: `git clone https://github.com/CanArslanDev/limn.git`
- Install: `pnpm install` (the repo pins pnpm 9.x via `packageManager`; Node 20.10+ via `.nvmrc`)
- Build: `pnpm run build`
- Test: `pnpm run test`
- Typecheck: `pnpm run typecheck`
- Lint: `pnpm run lint`
- All gates at once: `pnpm run verify`

## Architecture at a glance

Limn enforces a unidirectional dependency flow. Each layer imports only downstream layers:

```
public surface (ai, tool, defineConfig)
        |
        v
client (high-level orchestration, retries, tracing)
        |
        v
providers (Anthropic, OpenAI adapters)
        |
        v
SDK (peer-dependency)
```

The architecture test in `test/architecture/import_flow.test.ts` enforces these boundaries. Adding a new layer requires extending the test in the same commit. Trace through `src/index.ts` and `src/client/` to see how a single call flows end-to-end.

## Adding a provider

Providers live in `src/providers/<name>/`. A provider implements the internal `Provider` interface (`request`, `stream`, `models`) and surfaces nothing to user code beyond the model-name string it accepts.

```ts
// src/providers/example/example_provider.ts
import type { Provider, ProviderRequest, ProviderResponse } from "../provider";

export class ExampleProvider implements Provider {
  readonly name = "example" as const;

  async request(req: ProviderRequest): Promise<ProviderResponse> {
    // adapt req -> SDK call -> normalize -> return
  }

  async *stream(req: ProviderRequest): AsyncIterable<string> {
    // adapt req -> streaming SDK call -> yield chunks
  }
}
```

Register it in `src/providers/registry.ts` and add a unit test at `test/providers/example_provider.test.ts` in the same commit.

## Adding a tool helper

The `tool({ name, description, input, run })` factory in `src/agent/tool.ts` is the single source of truth for tool shape. Adding a new helper or adapter (e.g. `mcpTool`, `httpTool`) means a new file under `src/agent/` plus a test under `test/agent/`. The factory output must satisfy the same `RegisteredTool` interface so the agent loop can dispatch it without special-casing.

## Documentation requirements

User-facing documentation lives in two surfaces that must stay in sync:

- `README.md` at the repo root: the 5-minute tour, API catalog, quickstart.
- `guides/*.md`: deeper, topic-focused companion guides (`getting-started`, `api-surface`, `cookbook`, `agents`, `inspect`, `troubleshooting`).

When you change behavior, public API surface, error taxonomy, or configuration shape, update **both** surfaces in the same commit. The README is where someone first lands; the guides are where they go when the README is not enough. Drift between the two is how "the docs lie" bugs creep in.

Rule of thumb:

- New function on the `ai` namespace -> `guides/api-surface.md` and the README quickstart.
- New configuration option -> `guides/getting-started.md` and the README configuration block.
- New error variant -> `guides/troubleshooting.md`.
- New CLI command or flag -> `guides/inspect.md` (for `inspect`) or a new guide for `init`.

## Testing requirements

- TDD is the expected workflow: write a failing test, make it pass, commit.
- Every new public API ships with tests in the same commit. No "tests in a follow-up PR".
- Both gates are non-negotiable for every PR: `pnpm run test` green AND `pnpm run lint` reporting 0 issues AND `pnpm run typecheck` passing.
- Tests mirror source layout: a provider at `src/providers/openai/openai_provider.ts` gets a test at `test/providers/openai_provider.test.ts`.
- Integration tests live under `test/integration/` and exercise the public surface end-to-end against a recorded fixture (no live API keys in CI).
- Architecture invariants live in `test/architecture/import_flow.test.ts`. Extend it whenever you add a new layer or import boundary.

## Provider keys in tests

CI runs without provider keys. Live-API tests are gated by the presence of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and skip otherwise. Default to recorded fixtures (under `test/fixtures/`) for everything that does not specifically exercise live behavior.

## Commit style

Limn uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new user-visible behaviour
- `fix:` bug fix
- `refactor:` internal change with no behaviour delta
- `test:` test-only change
- `chore:` tooling, release plumbing
- `docs:` docs-only change
- `perf:` performance improvement
- `build:` build-system or external-dependency change

Subject line stays at or under 72 characters. One logical change per commit. Don't bundle a refactor and a feature. Write the commit body to explain "why", not "what".

Do not include `Co-Authored-By:` trailers in any commit message.

## Pull request checklist

Before opening a PR, verify:

- Tests added or updated for the new behaviour.
- `pnpm run lint` reports 0 issues.
- `pnpm run typecheck` passes.
- `pnpm run test` passes.
- `test/architecture/import_flow.test.ts` still passes; if you added a layer, extend the guard in the same commit.
- `CHANGELOG.md` has an entry under `## [Unreleased]` for any user-visible change (skip for pure refactors, internal-only tests, or docs).
- README + relevant guide updated in the same commit if user-facing surface moved.

The PR template surfaces this checklist automatically.

## Reporting bugs

Open an issue using the bug report template (`.github/ISSUE_TEMPLATE/bug_report.md`). A minimal reproduction (the exact prompt or chat history, the model name, and the resulting error message) shortens the round-trip significantly. Feature requests go through the feature request template.
