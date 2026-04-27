# Limn examples

Each subdirectory is a runnable, single-file demo of one Limn surface. The same configuration applies to all of them: set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in your environment, install dependencies at the repo root with `pnpm install`, then run an example with:

```bash
pnpm tsx examples/01-basic-ask/index.ts
```

| Example                     | What it shows                                                              |
| --------------------------- | -------------------------------------------------------------------------- |
| `01-basic-ask`              | The smallest possible Limn program: one `ai.ask` call.                     |
| `02-chat`                   | Multi-turn conversation with role + content message shape.                 |
| `03-extract`                | Schema-validated extraction with Zod, including the validation-failure path. |
| `04-stream`                 | Token-by-token streaming, both via `for await` and via `onChunk`.          |
| `05-agent-with-tool`        | Agent loop with one registered tool; uses `ai.agent({ tools: [...] })`.    |

These examples land alongside the implementation phases. Today (Phase 0), each `index.ts` is a minimal placeholder that throws a clear "implementation not yet shipped" message; they exist so the directory layout is fixed and PRs that ship a phase update the corresponding example in the same commit.
