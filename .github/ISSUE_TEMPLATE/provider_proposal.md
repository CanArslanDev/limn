---
name: Provider proposal
about: Propose adding a new LLM provider adapter to Traceworks
title: "[provider] "
labels: provider, enhancement
assignees: ''
---

## Provider name

Anthropic and OpenAI ship by default. Common candidates: Google Gemini, Mistral, Cohere, AWS Bedrock, local models via Ollama, Groq, Fireworks.

## Why this provider

What does it unlock that the existing two providers do not? Cost, latency, on-device inference, region, model breadth, etc.

## SDK + API surface

- Official SDK (npm name + version):
- Authentication shape (API key in env var, OIDC, signed requests, ...):
- Streaming support (SSE? WebSocket? polling?):
- Tool / function-calling support (matches OpenAI shape, Anthropic shape, custom?):
- Structured output / JSON mode support:
- Vision / file attachment support:

## Model name strategy

How should users name models in Traceworks code? Flat strings (`"gemini-1.5-pro"`), namespaced (`"google:gemini-1.5-pro"`), or via a separate factory?

## Sample code

```ts
import { ai } from "traceworks";

const reply = await ai.ask("hello", { model: "<your-proposed-model-string>" });
```

## Adoption signal

Roughly how many Traceworks users would actually use this? Link an issue or discussion if there's demand. Provider adapters with no adoption signal tend to stay in planning indefinitely.

## Willing to land it yourself?

- [ ] Yes - I will open a PR implementing this proposal.
- [ ] Yes, with guidance - I can pair if someone scopes the initial design.
- [ ] No - leaving it for the maintainer / community.
