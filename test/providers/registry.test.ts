/**
 * Provider registry routing. The user names a model; the registry looks up
 * which provider owns it. New models added to model_name.ts must be claimed
 * by exactly one provider.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "../../src/errors/index.js";
import { AnthropicProvider } from "../../src/providers/anthropic/anthropic_provider.js";
import { ANTHROPIC_MODELS, OPENAI_MODELS } from "../../src/providers/model_name.js";
import { OpenAIProvider } from "../../src/providers/openai/openai_provider.js";
import type { Provider } from "../../src/providers/provider.js";
import {
  type ProviderName,
  getProvider,
  providerFor,
  registerProvider,
  resolveProvider,
  unregisterProvider,
} from "../../src/providers/registry.js";

class FakeProvider implements Provider {
  public readonly name: string;
  public constructor(name: string) {
    this.name = name;
  }
  public async request(): Promise<never> {
    throw new Error("not used in registry tests");
  }
  public requestStream(): never {
    throw new Error("not used in registry tests");
  }
}

const NAMES: readonly ProviderName[] = ["anthropic", "openai"];

afterEach(() => {
  // Reset the module-scoped registry between tests so subsequent describe
  // blocks (and other test files in the same Vitest worker) start from the
  // "no provider registered" state a fresh process would see.
  for (const n of NAMES) {
    unregisterProvider(n);
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

  it("getProvider throws AuthError mentioning the env var when bootstrap has nothing to bootstrap", () => {
    // No registration, no env key: bootstrap returns null, getProvider should
    // throw AuthError pointing at the env var to set. We stub the env to "" so
    // the bootstrap path treats the key as missing even on developer machines
    // that have ANTHROPIC_API_KEY set in their shell.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      expect(() => getProvider("anthropic")).toThrow(AuthError);
      expect(() => getProvider("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("unregisterProvider removes a provider; subsequent getProvider re-bootstraps or throws", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      registerProvider("anthropic", new FakeProvider("anthropic"));
      unregisterProvider("anthropic");
      expect(() => getProvider("anthropic")).toThrow(AuthError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("getProvider lazily bootstraps an AnthropicProvider when the env key is set and no provider was registered", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    try {
      // Defensive: ensure the registry slot is empty before bootstrap.
      unregisterProvider("anthropic");
      const p = getProvider("anthropic");
      expect(p).toBeInstanceOf(AnthropicProvider);
      // Subsequent calls return the same cached instance, not a fresh one.
      expect(getProvider("anthropic")).toBe(p);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("resolveProvider", () => {
  it("delegates to getProvider when no per-call apiKey is supplied", () => {
    const fake = new FakeProvider("anthropic");
    registerProvider("anthropic", fake);
    expect(resolveProvider("anthropic")).toBe(fake);
  });

  it("constructs a fresh AnthropicProvider when an apiKey is supplied, bypassing the cached registry slot", () => {
    const fake = new FakeProvider("anthropic");
    registerProvider("anthropic", fake);
    const fresh = resolveProvider("anthropic", "sk-ant-percall");
    expect(fresh).toBeInstanceOf(AnthropicProvider);
    expect(fresh).not.toBe(fake);
    // The cached slot must be untouched: a subsequent call without the
    // override returns the registered fake, not the per-call instance.
    expect(getProvider("anthropic")).toBe(fake);
  });

  it("constructs a fresh OpenAIProvider when an apiKey is supplied for openai", () => {
    const fake = new FakeProvider("openai");
    registerProvider("openai", fake);
    const fresh = resolveProvider("openai", "sk-percall");
    expect(fresh).toBeInstanceOf(OpenAIProvider);
    expect(fresh).not.toBe(fake);
    expect(getProvider("openai")).toBe(fake);
  });
});
