# Troubleshooting

Every Limn failure is typed. This guide lists the variants, what triggers them, and the documented recovery path.

## The hierarchy

```
LimnError                     // abstract base
├── AuthError                 // 401/403; bad key
├── RateLimitError            // 429; carries optional retryAfterMs
├── ProviderError             // upstream 5xx, transport, malformed
├── ModelTimeoutError         // exceeded configured timeoutMs
├── SchemaValidationError     // ai.extract or tool input mismatch
└── ToolExecutionError        // a registered tool's run callback threw
```

`instanceof LimnError` once, then narrow on the variant.

## `AuthError`

The provider returned 401/403 or the SDK could not find a key.

- Confirm `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set in the environment that runs your code (not just your shell).
- Check the key has not been rotated.
- Recovery: surface to the user. Limn does not retry auth failures because waiting does not fix them.

## `RateLimitError`

The provider returned 429 or signaled exhaustion via headers. Carries `retryAfterMs` when the provider supplies it.

- The default retry policy honors `Retry-After` and backs off exponentially up to `retry.maxAttempts` (default 3).
- If you see this consistently, lower call concurrency or upgrade your provider plan.
- Recovery: automatic retry; surface to the user on exhaustion.

## `ProviderError`

A 5xx, a transport error, an unparseable response, or a deterministic 4xx client fault from the provider.

- Carries the provider name (`anthropic` / `openai`) and the underlying SDK error in `cause`.
- Carries a `retryable` boolean. Transient faults (5xx, transport blips) default to `retryable: true` and the retry strategy backs off exponentially. Deterministic faults (4xx client errors, caller bugs such as passing `role: "system"` to Anthropic via the messages array) carry `retryable: false`; the retry strategy gives up immediately because re-issuing the same request will fail the same way.
- Recovery: automatic retry on transient faults; surface deterministic faults to the user with the underlying `cause` for debugging.

## `ModelTimeoutError`

The request did not return within `timeoutMs` (default 60_000).

- Long generations may legitimately exceed the default. Bump `timeoutMs` per call or in `limn.config.ts`.
- For genuinely long tasks, prefer `ai.stream` so partial output is visible while the model is still working.
- Recovery: retry with a longer timeout, or surface to the user.

## `SchemaValidationError`

`ai.extract` received a model response that did not validate against the supplied Zod schema, or a tool's input failed validation.

- Carries `expectedSchemaName` and `actualPayload` so the inspector can render a diff.
- With `retryOnSchemaFailure: true` (or the equivalent `onError` policy on an agent), Limn retries once with the validation error fed back to the model.
- Recovery: relax the schema, switch to a more capable model, or accept the failure and surface to the user.

## `ToolExecutionError`

A registered tool's `run` callback threw. Carries `toolName` and `toolInput`.

- The agent loop surfaces this back to the model on the next turn (so the model can adjust its plan), unless `onError: { ToolExecutionError: { retry: "never" } }`.
- The original error lives on `cause` so you can re-throw or log it without losing the stack.

## Common failure modes

### "Unknown model: ..."

Add the model name to `src/providers/model_name.ts` and map it to the right provider in `src/providers/registry.ts`. Then send a PR.

### `AuthError: Provider "anthropic" requires an API key. Set ANTHROPIC_API_KEY ...`

You called a model owned by a vendor whose key is missing AND no provider was registered manually. Two fixes:

- Set the env var (`export ANTHROPIC_API_KEY=sk-ant-...` or the OpenAI equivalent) and rerun. Limn lazily constructs the provider on the next call.
- Or call `registerProvider("anthropic", new AnthropicProvider(myKey))` explicitly before the first `ai.ask` if your key lives somewhere other than the env (a secret manager, a CLI flag, etc.).

The same message variant exists for `OPENAI_API_KEY` once batch 1.6 lights up the OpenAI adapter; until then any call against an OpenAI model raises this AuthError because no bootstrap path exists yet.

### Schema diff explodes in the inspector

Phase 2 issue. Until the diff renderer ships, `JSON.stringify(err.actualPayload, null, 2)` is the manual workaround.

## Still stuck?

Open an issue with the bug-report template. Include the exact code, the model name, the trace JSON (redact responses if needed), and the full error message.
