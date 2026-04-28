/**
 * Provider registry routing. The user names a model; the registry looks up
 * which provider owns it. New models added to model_name.ts must be claimed
 * by exactly one provider.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS, OPENAI_MODELS } from "../../src/providers/model_name.js";
import type { Provider } from "../../src/providers/provider.js";
import {
  getProvider,
  type ProviderName,
  providerFor,
  registerProvider,
} from "../../src/providers/registry.js";

class FakeProvider implements Provider {
  public readonly name: string;
  public constructor(name: string) {
    this.name = name;
  }
  public async request(): Promise<never> {
    throw new Error("not used in registry tests");
  }
  public stream(): AsyncIterable<string> {
    throw new Error("not used in registry tests");
  }
}

const NAMES: readonly ProviderName[] = ["anthropic", "openai"];

afterEach(() => {
  // Reset the module-scoped registry between tests by registering fresh
  // throwing providers so subsequent describe blocks start from a known state.
  for (const n of NAMES) {
    registerProvider(n, new FakeProvider(n));
  }
});

describe("providerFor", () => {
  it("routes every Anthropic model to anthropic", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(providerFor(model)).toBe("anthropic");
    }
  });

  it("routes every OpenAI model to openai", () => {
    for (const model of OPENAI_MODELS) {
      expect(providerFor(model)).toBe("openai");
    }
  });

  it("throws on unknown model names", () => {
    // Type-system bypass to simulate a typo or stale model name.
    expect(() => providerFor("not-a-real-model" as never)).toThrow(/Unknown model/);
  });
});

describe("registerProvider + getProvider", () => {
  it("getProvider returns a previously registered provider by name", () => {
    const fake = new FakeProvider("anthropic");
    registerProvider("anthropic", fake);
    expect(getProvider("anthropic")).toBe(fake);
  });

  it("registerProvider overwrites a prior registration for the same name", () => {
    const first = new FakeProvider("openai");
    const second = new FakeProvider("openai");
    registerProvider("openai", first);
    registerProvider("openai", second);
    expect(getProvider("openai")).toBe(second);
  });

  it("getProvider throws a clear message when the name was never registered", () => {
    // Cast to bypass the union check; simulates a future provider name not
    // yet wired into the registry.
    expect(() => getProvider("ghost" as ProviderName)).toThrow(
      /Provider "ghost" not registered/,
    );
  });
});
