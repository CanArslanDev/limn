# Anthropic recorded fixtures

JSON payloads replayed by `test/providers/anthropic_provider.test.ts`. Each
fixture mirrors a real `POST /v1/messages` response body the Anthropic API
emits today; the test injects a fake `fetch` into the SDK that returns the
fixture as the HTTP response, so the SDK constructs its real error classes
from real status codes and the adapter exercises its real `instanceof`
mapping.

## Success payloads

- `messages_success.json` - single text block, `stop_reason: "end_turn"`,
  the canonical happy path.
- `messages_max_tokens.json` - single text block, `stop_reason: "max_tokens"`,
  exercises the truncation stop-reason mapping.
- `messages_multi_text.json` - two text blocks, exercises in-order
  concatenation.
- `messages_with_tool_use.json` - text + tool_use + text blocks; today the
  adapter only concatenates text, so we assert tool_use is skipped.
  Phase 3's tool dispatch will start consuming the tool_use block; this
  fixture is reusable then.
- `messages_stop_sequence.json` - `stop_reason: "stop_sequence"`, exercises
  the "treat as end" mapping.
- `messages_null_stop_reason.json` - `stop_reason: null`, exercises the null
  fallback.

## Error payloads

Every error fixture follows Anthropic's documented envelope:
`{ type: "error", error: { type: <kind>, message: <human> } }`. The HTTP
status is set by the test's fake `fetch`; the SDK's `APIError.generate`
inspects the status and returns the matching subclass
(`AuthenticationError` for 401, `PermissionDeniedError` for 403,
`RateLimitError` for 429, `InternalServerError` for 5xx, plain `APIError`
for everything else).

- `error_401.json` - `authentication_error` envelope; paired with HTTP 401
  in tests to exercise `AuthError` mapping.
- `error_403.json` - `permission_error` envelope; paired with HTTP 403.
- `error_429.json` - `rate_limit_error` envelope; tests pair with HTTP 429
  both with and without a `Retry-After` header to exercise
  `RateLimitError(retryAfterMs)` parsing.
- `error_500.json` - `api_error` envelope; paired with HTTP 500 to
  exercise `ProviderError` mapping for 5xx.
- `error_418.json` - generic `api_error` envelope; paired with HTTP 418
  (a status the SDK does not have a dedicated subclass for) to exercise
  the bare `APIError` -> `ProviderError` fallthrough.

## Adding fixtures

Capture a real response in dev (e.g. by logging the SDK's internal HTTP
response, or by running curl against the API). Strip API keys, request
ids, internal log ids, and any user-identifiable content. Drop the file
in this directory, document its purpose in the relevant section above,
and reference it from a new test in `anthropic_provider.test.ts`.
