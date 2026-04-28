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
  /** Queued responses. FIFO. Public for read-only inspection. */
  public readonly responses: ProviderResponse[] = [];
  /** Queued errors. FIFO. Win over `responses` when both are non-empty. */
  public readonly errors: Error[] = [];
  /** Captured incoming requests in arrival order. Useful for assertions. */
  public readonly requests: ProviderRequest[] = [];

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
    this.responses.push(response);
  }

  /** Append an error to the queue. Errors win over responses when both are queued. */
  public pushError(error: Error): void {
    this.errors.push(error);
  }

  /** Clear every queue and the captured requests array. Call between tests. */
  public reset(): void {
    this.responses.length = 0;
    this.errors.length = 0;
    this.requests.length = 0;
  }

  public async request(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    if (this.errors.length > 0) {
      const next = this.errors.shift();
      // shift() returns undefined only when length was 0; checked above.
      if (next === undefined) {
        throw new ProviderError("MockProvider: error queue desync", this.name);
      }
      throw next;
    }
    if (this.responses.length > 0) {
      const next = this.responses.shift();
      if (next === undefined) {
        throw new ProviderError("MockProvider: response queue desync", this.name);
      }
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
