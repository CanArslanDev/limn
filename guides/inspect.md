# Inspector

The local debug UI. The "wow moment" of Limn. Phase 2 ships the UI; Phase 1 ships the trace JSON it reads.

## Trace storage

Every call from Layer 1 and Layer 2 writes a structured JSON record to `.limn/traces/<id>.json` by default. The directory is configurable via `trace.dir` in `limn.config.ts` or `LIMN_TRACE_DIR` in the environment.

Disable tracing entirely with `trace.enabled: false`. Off-by-default key redaction can be turned off with `trace.redactKeys: false` if you really want to log raw payloads (not recommended).

## Trace JSON schema

Stable target shape (subject to small refinements during Phase 1):

```jsonc
{
  "id": "trc_01HXXX...",
  "timestamp": "2026-04-28T00:00:00Z",
  "kind": "ask",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "latencyMs": 1234,
  "usage": { "inputTokens": 250, "outputTokens": 87 },
  "request": { /* normalized provider-agnostic request */ },
  "response": { /* normalized provider-agnostic response */ },
  "error": null,
  "parentTraceId": null
}
```

Agent runs and tool calls carry `parentTraceId` so the inspector can render a tree.

## Running the inspector

Phase 2 placeholder (target shape):

```bash
npx limn inspect
# opens localhost:3000
```

The local UI shows:

- Trace list with date, model, status, cost, duration filters.
- Per-trace detail: prompt, response, token counts, cost breakdown, latency per step.
- Schema diff: side-by-side "expected vs. actual" when an extraction fails.
- Replay: re-run a past trace with the same inputs against the live provider.

Local-only: no telemetry, no account, no network calls beyond the LLM provider.

## Reading traces without the UI

While the UI is in flight, the JSON files are human-readable. A quick browse:

```bash
ls -lt .limn/traces/ | head
cat .limn/traces/$(ls -t .limn/traces/ | head -1) | jq .
```

The schema is intentionally stable so any tool that speaks JSON can ingest it.
