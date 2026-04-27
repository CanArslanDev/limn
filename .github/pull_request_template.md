## Summary

<!-- 1-3 sentences describing the change and why it's needed. -->

## Type of change

- [ ] feat (new user-visible behavior)
- [ ] fix (bug fix)
- [ ] refactor (internal change, no behavior delta)
- [ ] test (test-only change)
- [ ] docs (documentation-only change)
- [ ] chore (tooling, release plumbing)
- [ ] perf (performance improvement)
- [ ] build (build-system or external-dependency change)

## Checklist

- [ ] Tests added for new behavior (RED then GREEN, in the same commit)
- [ ] `pnpm run test` passes locally
- [ ] `pnpm run typecheck` reports 0 errors
- [ ] `pnpm run lint` reports 0 issues under the project's Biome config
- [ ] Test file path mirrors source path (`src/providers/openai/openai_provider.ts` -> `test/providers/openai_provider.test.ts`)
- [ ] `test/architecture/import_flow.test.ts` still passes; extended in this PR if a new layer or import boundary was added
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` for any user-visible change (skip for pure refactors / internal tests / docs-only)
- [ ] README and relevant `guides/*.md` updated in the same commit if the change moved a user-facing surface
- [ ] No em-dashes (`—`) or en-dashes (`–`) in user-facing markdown (README, CHANGELOG, guides, this PR body). Source-code comments and JSDoc are exempt.
- [ ] No `Co-Authored-By:` trailers in any commit message

## Context / screenshots

<!-- Link related issues with "Closes #N". For inspector / CLI changes, attach a screenshot or short clip. -->

## Notes for reviewers

<!-- Anything surprising, risky, or non-obvious about the change. Provider SDK quirks, deferred scope, type-system tricks, etc. -->
