/**
 * Test-only `Provider` implementation. Returns programmed responses or throws
 * programmed errors so test code can drive `ai.ask` (and later `ai.chat`,
 * `ai.extract`) end-to-end without a network call.
 *
 * Never registered into the production registry by Traceworks itself: tests
 * register it explicitly via `registerProvider("anthropic", new MockProvider())`
 * and `reset()` after each test to avoid leaking the mock to neighbouring
 * suites.
 *
 * Lives under `src/providers/_mock/` so the architecture test can apply the
 * same "adapter may import providers + errors" rule that constrains the real
 * adapters. The leading underscore signals "not a real vendor" at a glance
 * during code review.
 */

import { ProviderError } from "../../errors/index.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamResult,
} from "../provider.js";

/**
 * Scripted stream payload. `chunks` are yielded in order; `usage` resolves
 * the {@link ProviderStreamResult.usage} promise once the iterator drains.
 * `errorAfterChunks`, when set, makes the iterator throw it AFTER yielding
 * `chunks` (mid-stream failure scripting); the usage promise rejects with
 * the same error so callers awaiting it see the failure too.
 */
interface StreamScript {
  readonly chunks: readonly string[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly errorAfterChunks?: Error;
}

/**
 * Programmable provider used exclusively by tests. Push responses or errors
 * onto the queues, then call into the public surface; each invocation of
 * `request()` consumes one entry.
 */
export class MockProvider implements Provider {
  public readonly name: string;

  // Private mutable backing arrays + public readonly getters: external code
  // can read (`mock.responses[0]`, `mock.responses.length`) but cannot call
  // `push` / `shift` / `length = 0` to bypass the documented mutation API
  // (pushResponse / pushError / reset). A plain `readonly ProviderResponse[]`
  // public field would block external mutations BUT also block the internal
  // `this.responses.push(...)` calls; the getter pattern keeps both ergonomic.
  private readonly _responses: ProviderResponse[] = [];
  private readonly _errors: Error[] = [];
  private readonly _requests: ProviderRequest[] = [];
  // Stream queues live alongside the request queues. Stream errors win over
  // chunk scripts when both are queued, mirroring the request/error semantics.
  private readonly _streamScripts: StreamScript[] = [];
  private readonly _streamErrors: Error[] = [];
  private readonly _streamRequests: ProviderRequest[] = [];

  /** Queued responses. FIFO. Read-only at the public surface. */
  public get responses(): readonly ProviderResponse[] {
    return this._responses;
  }
  /** Queued errors. FIFO. Win over `responses` when both are non-empty. */
  public get errors(): readonly Error[] {
    return this._errors;
  }
  /** Captured incoming requests in arrival order. Useful for assertions. */
  public get requests(): readonly ProviderRequest[] {
    return this._requests;
  }
  /** Captured incoming streaming requests in arrival order. */
  public get streamRequests(): readonly ProviderRequest[] {
    return this._streamRequests;
  }

  /**
   * Construct a mock that pretends to be the given provider. Defaults to
   * "anthropic" so the most common test path (`registerProvider("anthropic",
   * new MockProvider())`) reads naturally.
   */
  public constructor(name: "anthropic" | "openai" = "anthropic") {
    this.name = name;
  }

  /** Append a response to the queue. */
  public pushResponse(response: ProviderResponse): void {
    this._responses.push(response);
  }

  /** Append an error to the queue. Errors win over responses when both are queued. */
  public pushError(error: Error): void {
    this._errors.push(error);
  }

  /**
   * Script the next streaming call. The chunks are yielded in order;
   * `usage` resolves the {@link ProviderStreamResult.usage} promise once
   * the iterator drains. When `errorAfterChunks` is supplied the iterator
   * throws it AFTER yielding `chunks` (mid-stream failure scripting).
   */
  public pushStreamChunks(
    chunks: readonly string[],
    usage: { readonly inputTokens: number; readonly outputTokens: number },
    errorAfterChunks?: Error,
  ): void {
    this._streamScripts.push({
      chunks,
      usage,
      ...(errorAfterChunks === undefined ? {} : { errorAfterChunks }),
    });
  }

  /**
   * Script the next streaming call to throw immediately on the first
   * iteration. Used to exercise the dispatcher's first-chunk retry path:
   * a stream that fails before any chunk emits should be safe to re-issue.
   */
  public pushStreamError(error: Error): void {
    this._streamErrors.push(error);
  }

  /** Clear every queue and the captured requests array. Call between tests. */
  public reset(): void {
    this._responses.length = 0;
    this._errors.length = 0;
    this._requests.length = 0;
    this._streamScripts.length = 0;
    this._streamErrors.length = 0;
    this._streamRequests.length = 0;
  }

  public async request(req: ProviderRequest): Promise<ProviderResponse> {
    this._requests.push(req);
    if (this._errors.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length check on previous line guarantees non-empty
      const next = this._errors.shift()!;
      throw next;
    }
    if (this._responses.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length check on previous line guarantees non-empty
      const next = this._responses.shift()!;
      return next;
    }
    throw new ProviderError(
      "MockProvider has no queued response. Call pushResponse() before invoking.",
      this.name,
    );
  }

  /**
   * Begin a scripted streaming call. Captures `req` in `streamRequests` and
   * returns the two-channel result. Failure modes:
   *   - `pushStreamError(err)` makes the next call throw `err` synchronously
   *     (well, on the first iteration of the returned iterator); the usage
   *     promise rejects with the same error.
   *   - `pushStreamChunks(chunks, usage, errorAfterChunks?)` yields chunks
   *     in order, then either resolves usage or throws `errorAfterChunks`
   *     after the chunks (mid-stream failure scripting).
   *   - No script queued -> the iterator throws `ProviderError`.
   */
  public requestStream(req: ProviderRequest): ProviderStreamResult {
    this._streamRequests.push(req);

    if (this._streamErrors.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length check on previous line guarantees non-empty
      const queuedError = this._streamErrors.shift()!;
      const failOnFirstNext = (async function* failingStream(): AsyncIterable<string> {
        throw queuedError;
        // Unreachable yield to satisfy AsyncIterable typing in some runtimes.
        // biome-ignore lint/correctness/noUnreachable: typing aid; never executes
        yield "";
      })();
      return {
        stream: failOnFirstNext,
        usage: Promise.reject(queuedError),
      };
    }

    if (this._streamScripts.length === 0) {
      const err = new ProviderError(
        "MockProvider has no queued stream script. Call pushStreamChunks() or pushStreamError() before invoking.",
        this.name,
      );
      const failOnFirstNext = (async function* failingStream(): AsyncIterable<string> {
        throw err;
        // biome-ignore lint/correctness/noUnreachable: typing aid; never executes
        yield "";
      })();
      return {
        stream: failOnFirstNext,
        usage: Promise.reject(err),
      };
    }

    // biome-ignore lint/style/noNonNullAssertion: length check on previous line guarantees non-empty
    const script = this._streamScripts.shift()!;
    // Promise.withResolvers-style hand-roll: the executor runs synchronously
    // so resolve/reject are guaranteed to be assigned before the generator
    // body below runs. Definite-assignment assertions document this for TS.
    let usageResolve!: (value: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    }) => void;
    let usageReject!: (reason: unknown) => void;
    const usagePromise = new Promise<{
      readonly inputTokens: number;
      readonly outputTokens: number;
    }>((resolve, reject) => {
      usageResolve = resolve;
      usageReject = reject;
    });
    const stream = (async function* scriptedStream(): AsyncIterable<string> {
      try {
        for (const chunk of script.chunks) {
          yield chunk;
        }
        if (script.errorAfterChunks !== undefined) {
          usageReject(script.errorAfterChunks);
          throw script.errorAfterChunks;
        }
        usageResolve(script.usage);
      } catch (err) {
        usageReject(err);
        throw err;
      }
    })();
    return { stream, usage: usagePromise };
  }
}
