/**
 * Defaults sanity. The defaults are user-visible because zero-config callers
 * inherit them on every call; a bad shift here is a behavior change.
 */

import { describe, expect, it } from "vitest";
import { defineConfig } from "../../src/config/define_config.js";
import { DEFAULT_CONFIG } from "../../src/config/limn_config.js";
import { DEFAULT_MODEL } from "../../src/providers/model_name.js";

describe("config defaults", () => {
  it("uses the documented default model", () => {
    expect(DEFAULT_CONFIG.defaultModel).toBe(DEFAULT_MODEL);
  });

  it("retries with exponential backoff up to 3 attempts", () => {
    expect(DEFAULT_CONFIG.retry.maxAttempts).toBe(3);
    expect(DEFAULT_CONFIG.retry.backoff).toBe("exponential");
    expect(DEFAULT_CONFIG.retry.initialDelayMs).toBe(500);
  });

  it("writes traces to .limn/traces by default with key redaction on", () => {
    expect(DEFAULT_CONFIG.trace.enabled).toBe(true);
    expect(DEFAULT_CONFIG.trace.dir).toBe(".limn/traces");
    expect(DEFAULT_CONFIG.trace.redactKeys).toBe(true);
  });

  it("times out at 60 seconds by default", () => {
    expect(DEFAULT_CONFIG.timeoutMs).toBe(60_000);
  });
});

describe("defineConfig", () => {
  it("returns the config it was given (identity helper)", () => {
    const cfg = defineConfig({ defaultModel: "claude-opus-4-7" });
    expect(cfg.defaultModel).toBe("claude-opus-4-7");
  });
});
