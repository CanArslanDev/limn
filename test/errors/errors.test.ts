/**
 * Error hierarchy contract. Every typed failure derives from `LimnError` so
 * that consumers can `instanceof LimnError` once and narrow on the variant.
 * If a new error variant is added, this file gets a new entry.
 */

import { describe, expect, it } from "vitest";
import {
  AuthError,
  ConfigLoadError,
  LimnError,
  ModelTimeoutError,
  ProviderError,
  RateLimitError,
  SchemaValidationError,
  ToolExecutionError,
} from "../../src/errors/index.js";

describe("error hierarchy", () => {
  it("every variant extends LimnError and carries a unique code", () => {
    const variants: readonly LimnError[] = [
      new AuthError("bad key"),
      new RateLimitError("slow down", 5_000),
      new ProviderError("upstream 500", "anthropic"),
      new ModelTimeoutError("timed out", 30_000),
      new SchemaValidationError("schema mismatch", "Person", { foo: 1 }),
      new ToolExecutionError("tool boom", "search", { query: "x" }),
      new ConfigLoadError("config bad", "/abs/path/limn.config.ts"),
    ];

    const codes = new Set(variants.map((v) => v.code));
    expect(codes.size).toBe(variants.length);
    for (const v of variants) {
      expect(v).toBeInstanceOf(LimnError);
      expect(v.message.length).toBeGreaterThan(0);
    }
  });

  it("RateLimitError carries the optional retryAfterMs", () => {
    const err = new RateLimitError("slow", 1_000);
    expect(err.retryAfterMs).toBe(1_000);
  });

  it("SchemaValidationError carries the schema name and the payload", () => {
    const err = new SchemaValidationError("oops", "Person", { partial: true });
    expect(err.expectedSchemaName).toBe("Person");
    expect(err.actualPayload).toEqual({ partial: true });
  });

  it("ToolExecutionError carries the tool name and the input", () => {
    const err = new ToolExecutionError("boom", "search", { query: "rlhf" });
    expect(err.toolName).toBe("search");
    expect(err.toolInput).toEqual({ query: "rlhf" });
  });

  it("ConfigLoadError carries the offending path and a typed code", () => {
    const path = "/abs/path/limn.config.ts";
    const cause = new SyntaxError("Unexpected token");
    const err = new ConfigLoadError("Failed to load config", path, cause);
    expect(err.code).toBe("CONFIG_LOAD");
    expect(err.configPath).toBe(path);
    expect(err.cause).toBe(cause);
  });
});
