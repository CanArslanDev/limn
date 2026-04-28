/**
 * Sealed error hierarchy for Limn. Every typed failure derives from `LimnError`
 * so that consumers can `instanceof LimnError` once, then narrow on the
 * variant. Each variant documents its expected recovery path inline.
 */

export abstract class LimnError extends Error {
  public abstract readonly code: string;

  public constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Provider returned a 401 / 403 or the local SDK could not authenticate.
 * Recovery: surface to the user, do not retry. Bad keys never become good
 * by waiting.
 */
export class AuthError extends LimnError {
  public readonly code = "AUTH_ERROR" as const;
}

/**
 * Provider returned a 429 or signaled rate-limit exhaustion via headers.
 * Recovery: exponential backoff up to the configured `retry.maxAttempts`,
 * honoring `Retry-After` when present.
 */
export class RateLimitError extends LimnError {
  public readonly code = "RATE_LIMIT" as const;

  public constructor(
    message: string,
    public readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Generic provider failure (5xx, malformed response, transport error). Carries
 * the provider name and the underlying error so callers can branch on which
 * SDK exploded.
 *
 * `retryable` distinguishes transient faults (5xx, transport blips - the
 * default) from deterministic ones (4xx client errors, caller bugs). The
 * default is `true` because the original use case for `ProviderError` was
 * the 5xx / transport path; adapters that classify a fault as deterministic
 * pass `retryable: false` explicitly. The retry strategy reads this flag to
 * decide whether to back off or rethrow immediately.
 */
export class ProviderError extends LimnError {
  public readonly code = "PROVIDER_ERROR" as const;

  public constructor(
    message: string,
    public readonly provider: string,
    cause?: unknown,
    public readonly retryable: boolean = true,
  ) {
    super(message, cause);
  }
}

/**
 * Request did not return within the configured `timeoutMs`. Recovery: retry
 * once with a longer timeout, or surface to the caller.
 */
export class ModelTimeoutError extends LimnError {
  public readonly code = "MODEL_TIMEOUT" as const;

  public constructor(
    message: string,
    public readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * `ai.extract` received a model response that did not validate against the
 * supplied Zod schema. Carries both the expected schema description and the
 * actual payload so the inspector can render a side-by-side diff.
 */
export class SchemaValidationError extends LimnError {
  public readonly code = "SCHEMA_VALIDATION" as const;

  public constructor(
    message: string,
    public readonly expectedSchemaName: string,
    public readonly actualPayload: unknown,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * A registered tool's `run` callback threw. Carries the tool name and the
 * input that triggered the failure, so the agent loop can decide whether to
 * retry the model with corrective feedback or surface the error.
 */
export class ToolExecutionError extends LimnError {
  public readonly code = "TOOL_EXECUTION" as const;

  public constructor(
    message: string,
    public readonly toolName: string,
    public readonly toolInput: unknown,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}
