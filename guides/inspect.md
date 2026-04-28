# Inspector

The local debug UI. The "wow moment" of Limn. Phase 2 ships the UI; Phase 1 ships the trace JSON it reads.

## Trace storage

Every call from Layer 1 (and, in Phase 3, Layer 2) writes a structured
JSON record. The on-disk file name is a ULID for chronological sort
(`.limn/traces/<ulid>.json`); the trace `id` inside the body is a
separate stable `trc_<uuid>` used for cross-references. The directory
is configurable via `trace.dir` in `limn.config.ts`.

Disable tracing entirely with `trace.enabled: false`. On-by-default key
redaction can be turned off with `trace.redactKeys: false` if you really
want to log raw payloads (not recommended).

## Trace JSON schema

Stable target shape (subject to small refinements during Phase 1):

```jsonc
{
  "id": "trc_550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-04-28T00:00:00.000Z",
  "kind": "ask",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "latencyMs": 1234,
  "attempts": 1,
  "usage": { "inputTokens": 250, "outputTokens": 87 },
  "request": { /* normalized provider-agnostic request, post-redaction */ },
  "response": { /* normalized provider-agnostic response, post-redaction */ },
  "error": null,
  "redactedFields": ["request.messages.0.content"],
  "parentTraceId": null
}
```

`attempts` is the final attempt count from the retry strategy: `1` on a
first-try success or non-retryable failure, `>1` when a retry recovered.
`redactedFields` lists dot-path locators of every field the redactor
mutated, so the inspector can surface "what was scrubbed" without
leaking the secret itself. Agent runs and tool calls (Phase 3) carry
`parentTraceId` so the inspector can render a tree.

Locators use `.` for both object keys and array indices: a redaction
inside `{ messages: [{ content: "sk-..." }] }` surfaces as
`messages.0.content`. The format is intentionally simple to parse
character-by-character; bracket syntax (`messages[0].content`) is
reserved for a future revision if the inspector needs it.

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
