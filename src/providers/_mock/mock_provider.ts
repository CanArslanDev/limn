/**
 * Test-only `Provider` implementation. Returns programmed responses or throws
 * programmed errors so test code can drive `ai.ask` (and later `ai.chat`,
 * `ai.extract`) end-to-end without a network call.
 *
 * Never registered into the production registry by Limn itself: tests
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
import type { Provider, ProviderRequest, ProviderResponse } from "../provider.js";

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

  /** Clear every queue and the captured requests array. Call between tests. */
  public reset(): void {
    this._responses.length = 0;
    this._errors.length = 0;
    this._requests.length = 0;
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

  public stream(_req: ProviderRequest): AsyncIterable<string> {
    throw new ProviderError("MockProvider.stream not yet implemented (batch 1.7).", this.name);
  }
}
