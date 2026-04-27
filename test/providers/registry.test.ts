/**
 * Provider registry routing. The user names a model; the registry looks up
 * which provider owns it. New models added to model_name.ts must be claimed
 * by exactly one provider.
 */

import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
} from "../../src/providers/model_name.js";
import { providerFor } from "../../src/providers/registry.js";

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
