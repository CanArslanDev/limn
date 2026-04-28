/**
 * Unit tests for `redactKeys`. Drives the three pattern arms (sk-ant-,
 * sk-proj-, sk-), the length heuristic that protects short prose, the
 * deep-walk + dot-path semantics, and the immutability contract.
 */

import { describe, expect, it } from "vitest";
import { redactKeys } from "../../src/trace/redaction.js";

const ANT_KEY = "sk-ant-AAABBBCCCDDDDEEEFFFGGGHHH";
const PROJ_KEY = "sk-proj-AAABBBCCCDDDDEEEFFFGGGHHH";
const GENERIC_KEY = "sk-AAABBBCCCDDDDEEEFFFGGGHHH";

describe("redactKeys", () => {
  it("redacts a top-level Anthropic key string and reports the empty path", () => {
    const result = redactKeys(ANT_KEY);
    expect(result.value).toBe("[REDACTED]");
    expect(result.redacted).toEqual([""]);
  });

  it("redacts an Anthropic key embedded in surrounding prose", () => {
    const result = redactKeys(`Use ${ANT_KEY} to authenticate`);
    expect(result.value).toBe("Use [REDACTED] to authenticate");
    expect(result.redacted).toEqual([""]);
  });

  it("redacts OpenAI project keys", () => {
    const result = redactKeys({ apiKey: PROJ_KEY });
    expect(result.value).toEqual({ apiKey: "[REDACTED]" });
    expect(result.redacted).toEqual(["apiKey"]);
  });

  it("redacts generic OpenAI sk- keys", () => {
    const result = redactKeys({ apiKey: GENERIC_KEY });
    expect(result.value).toEqual({ apiKey: "[REDACTED]" });
    expect(result.redacted).toEqual(["apiKey"]);
  });

  it("does NOT redact strings beginning with sk- but too short to be a key", () => {
    const result = redactKeys({ channel: "sk-x", topic: "sk-short" });
    expect(result.value).toEqual({ channel: "sk-x", topic: "sk-short" });
    expect(result.redacted).toEqual([]);
  });

  it("walks nested objects + arrays and reports dot-paths with array indices", () => {
    const input = {
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: `Use ${ANT_KEY} please` },
      ],
    };
    const result = redactKeys(input);
    expect(result.value).toEqual({
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "Use [REDACTED] please" },
      ],
    });
    expect(result.redacted).toEqual(["messages.1.content"]);
  });

  it("matches the longest prefix first so sk-ant- is never misclassified as sk-", () => {
    // If sk- ran before sk-ant- the cleaned string would still be redacted,
    // but the pattern attribution would be wrong (which would later confuse
    // any audit code reading redactedFields). We assert behavioral parity:
    // an Anthropic-shaped key ends up as a single [REDACTED] block.
    const result = redactKeys(ANT_KEY);
    expect(result.value).toBe("[REDACTED]");
  });

  it("returns an empty redacted list when nothing matches", () => {
    const result = redactKeys({ messages: [{ role: "user", content: "hello world" }] });
    expect(result.redacted).toEqual([]);
    expect(result.value).toEqual({ messages: [{ role: "user", content: "hello world" }] });
  });

  it("does not mutate the input", () => {
    const input = { messages: [{ role: "user", content: ANT_KEY }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactKeys(input);
    expect(input).toEqual(snapshot);
  });

  it("handles multiple key occurrences inside a single string", () => {
    const result = redactKeys(`first ${ANT_KEY} then ${PROJ_KEY}`);
    expect(result.value).toBe("first [REDACTED] then [REDACTED]");
    expect(result.redacted).toEqual([""]);
  });

  it("passes primitives through untouched", () => {
    expect(redactKeys(42).value).toBe(42);
    expect(redactKeys(true).value).toBe(true);
    expect(redactKeys(null).value).toBe(null);
    expect(redactKeys(undefined).value).toBe(undefined);
  });

  it("does not stack overflow on cyclic objects", () => {
    const obj: { self?: unknown; safe: string } = {
      safe: "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE12345678",
    };
    obj.self = obj;
    const result = redactKeys(obj);
    // Cycle was preserved; the safe field still got redacted.
    const value = result.value as { self: unknown; safe: string };
    expect(value.safe).toBe("[REDACTED]");
    expect(value.self).toBe(value); // still self-referential
    expect(result.redacted).toContain("safe");
  });

  it("uses the same [REDACTED] marker for every key shape (no pattern attribution)", () => {
    const input = {
      a: "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE12345678",
      b: "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKE12345678",
      c: "sk-FAKEFAKEFAKEFAKEFAKEFAKE12345678",
    };
    const result = redactKeys(input);
    const value = result.value as { a: string; b: string; c: string };
    expect(value.a).toBe("[REDACTED]");
    expect(value.b).toBe("[REDACTED]");
    expect(value.c).toBe("[REDACTED]");
  });
});
