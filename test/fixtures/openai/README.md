# OpenAI recorded fixtures

JSON payloads replayed by `test/providers/openai_provider.test.ts`. Each
fixture mirrors a real `POST /v1/chat/completions` response body the OpenAI
API emits today; the test injects a fake `fetch` into the SDK that returns
the fixture as the HTTP response, so the SDK constructs its real error
classes from real status codes and the adapter exercises its real
`instanceof` mapping.

## Success payloads

- `chat_success.json` - single text choice, `finish_reason: "stop"`, the
  canonical happy path.
- `chat_max_tokens.json` - single text choice, `finish_reason: "length"`,
  exercises the truncation stop-reason mapping.
- `chat_tool_calls.json` - assistant message with `tool_calls` and
  `finish_reason: "tool_calls"`. The adapter today emits
  `stopReason: "tool_use"` and an empty `content`. Phase 3 will surface
  the tool-call payload through `ProviderResponse.toolCalls`; the fixture
  is reusable then.
- `chat_content_filter.json` - empty content with
  `finish_reason: "content_filter"`. Maps to `stopReason: "end"` so a
  filtered response surfaces as a non-error empty string.
- `chat_with_image.json` - same response shape as `chat_success.json`. The
  request body is what carries the attachment; the test asserts the
  outgoing body via the fake fetch capture.

## Error payloads

Every error fixture follows OpenAI's documented envelope:
`{ error: { message, type, param, code } }`. The HTTP status is set by the
test's fake `fetch`; the SDK's `APIError.generate` inspects the status and
returns the matching subclass (`AuthenticationError` for 401,
`PermissionDeniedError` for 403, `RateLimitError` for 429,
`InternalServerError` for 5xx, plain `APIError` for everything else).

- `error_400.json` - `invalid_request_error` envelope; paired with HTTP 400
  to exercise the bare `APIError` -> `ProviderError(retryable: false)`
  fallthrough for deterministic 4xx faults.
- `error_401.json` - `invalid_api_key` code; paired with HTTP 401 to
  exercise `AuthError` mapping.
- `error_403.json` - `permission_denied` code; paired with HTTP 403.
- `error_429.json` - `rate_limit_exceeded` envelope; tests pair with
  HTTP 429 both with and without a `Retry-After` header to exercise
  `RateLimitError(retryAfterMs)` parsing.
- `error_500.json` - `server_error` envelope; paired with HTTP 500 to
  exercise `ProviderError` mapping for 5xx (retryable defaults to true).
- `error_418.json` - generic `api_error` envelope; paired with HTTP 418
  (a status the SDK does not have a dedicated subclass for) to exercise
  the bare `APIError` -> `ProviderError` fallthrough.

## Adding fixtures

Capture a real response in dev (e.g. by logging the SDK's internal HTTP
response, or by running curl against the API). Strip API keys, request
ids, internal log ids, and any user-identifiable content. Drop the file
in this directory, document its purpose in the relevant section above,
and reference it from a new test in `openai_provider.test.ts`.
