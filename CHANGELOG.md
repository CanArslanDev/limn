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

### Notes

- Pre-1.0. Public API is in active design; expect breaking changes between
  every minor release until the v1.0.0 stability commitment.

[Unreleased]: https://github.com/CanArslanDev/limn/compare/HEAD...HEAD
