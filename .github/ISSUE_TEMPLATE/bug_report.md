---
name: Bug report
about: Report a reproducible defect in Traceworks
title: "[bug] "
labels: bug
assignees: ''
---

## Summary

A clear one-sentence description of what's wrong.

## Minimal reproduction

Paste the exact code that triggers the failure. Strip secrets but keep the model name and any relevant configuration.

```ts
import { ai } from "traceworks";

const result = await ai.ask("...", {
  model: "claude-sonnet-4-6",
  // ...
});
```

## Expected behavior

What you expected Traceworks to return, throw, or stream.

## Actual behavior

What Traceworks actually did. If a typed error was thrown (`RateLimitError`, `SchemaValidationError`, `ToolExecutionError`, ...), paste its full message.

## Trace

If the issue is reproducible locally, paste the relevant trace JSON from `.traceworks/traces/` (redact provider responses if they contain anything sensitive). Trace IDs are surfaced on every error message.

## Environment

- Traceworks version (`npm ls traceworks`):
- Node.js version (`node --version`):
- Package manager + version (pnpm / npm / yarn):
- OS:
- Provider: Anthropic / OpenAI / both
- Provider SDK version (`npm ls @anthropic-ai/sdk openai`):

## Additional context

Anything else: stack traces, screenshots of the inspector, related issues, prior art.
