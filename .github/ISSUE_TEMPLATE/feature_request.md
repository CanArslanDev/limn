---
name: Feature request
about: Propose a new function, configuration option, error variant, or CLI command for Traceworks
title: "[feature] "
labels: enhancement
assignees: ''
---

## What you want to write

Paste the code you want to be able to write. The more concrete, the better.

```ts
// example: what you want Traceworks to support
const result = await ai.someNewThing("...", { model: "claude-opus-4-7" });
```

## What Traceworks does today

Describe the current behavior: does it throw? Does it work but awkwardly? Is the surface missing entirely?

## Scope

- [ ] New function on the `ai` namespace.
- [ ] New configuration option (`traceworks.config.ts` field, env var, per-call option).
- [ ] New tool helper or agent capability.
- [ ] New provider adapter.
- [ ] New error variant.
- [ ] New CLI command or subcommand.
- [ ] Inspector / trace UI improvement.
- [ ] Other (explain).

## Why

What does this unlock? Real use cases beat hypotheticals.

## Layer

Traceworks is organized in three layers (Layer 1 = simple API, Layer 2 = agents + tools, Layer 3 = observability / debug UI). Which layer does this belong in? If it crosses layers, explain how.

## Additional context

Links to provider documentation, related issues, prior art in other LLM SDKs, etc.
