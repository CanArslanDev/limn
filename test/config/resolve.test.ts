/**
 * Resolution chain tests. The resolver merges four LimnConfig partials in
 * precedence order: defaults < env < limn.config.ts < per-call options.
 *
 * Each test asserts one transition in that chain so a regression localizes
 * to the offending arm. The resolver is the single source of truth for what
 * each layered call's effective config is, so the contract here is what
 * users see in `LimnConfig.*`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LimnUserConfig } from "../../src/config/define_config.js";
import { DEFAULT_CONFIG } from "../../src/config/limn_config.js";
import { envOverridesFromProcess, resolveConfig } from "../../src/config/resolve.js";

describe("resolveConfig", () => {
  it("returns DEFAULT_CONFIG verbatim when no layers contribute", () => {
    const resolved = resolveConfig({});
    expect(resolved).toEqual(DEFAULT_CONFIG);
  });

  it("env overrides win over defaults", () => {
    const env: LimnUserConfig = { trace: { dir: ".env-traces" } };
    const resolved = resolveConfig({ envOverrides: env });
    expect(resolved.trace.dir).toBe(".env-traces");
    // Sibling fields under `trace` retain their defaults.
    expect(resolved.trace.enabled).toBe(DEFAULT_CONFIG.trace.enabled);
    expect(resolved.trace.redactKeys).toBe(DEFAULT_CONFIG.trace.redactKeys);
  });

  it("file config wins over env overrides", () => {
    const env: LimnUserConfig = { defaultModel: "claude-opus-4-7" };
    const file: LimnUserConfig = { defaultModel: "claude-haiku-4-5" };
    const resolved = resolveConfig({ envOverrides: env, fileConfig: file });
    expect(resolved.defaultModel).toBe("claude-haiku-4-5");
  });

  it("per-call options win over file config", () => {
    const file: LimnUserConfig = { defaultModel: "claude-haiku-4-5" };
    const call: LimnUserConfig = { defaultModel: "gpt-4o-mini" };
    const resolved = resolveConfig({ fileConfig: file, callOverrides: call });
    expect(resolved.defaultModel).toBe("gpt-4o-mini");
  });

  it("merges nested retry and trace groups field-by-field, not group-by-group", () => {
    const file: LimnUserConfig = {
      retry: { maxAttempts: 7 },
      trace: { dir: ".file-traces" },
    };
    const call: LimnUserConfig = {
      retry: { initialDelayMs: 250 },
      trace: { enabled: false },
    };
    const resolved = resolveConfig({ fileConfig: file, callOverrides: call });
    expect(resolved.retry.maxAttempts).toBe(7); // from file
    expect(resolved.retry.initialDelayMs).toBe(250); // from call
    expect(resolved.retry.backoff).toBe(DEFAULT_CONFIG.retry.backoff); // from default
    expect(resolved.trace.dir).toBe(".file-traces"); // from file
    expect(resolved.trace.enabled).toBe(false); // from call
    expect(resolved.trace.redactKeys).toBe(DEFAULT_CONFIG.trace.redactKeys); // default
  });

  it("full chain: per-call beats file beats env beats defaults", () => {
    const env: LimnUserConfig = { timeoutMs: 1_000 };
    const file: LimnUserConfig = { timeoutMs: 2_000 };
    const call: LimnUserConfig = { timeoutMs: 3_000 };
    expect(resolveConfig({ envOverrides: env }).timeoutMs).toBe(1_000);
    expect(resolveConfig({ envOverrides: env, fileConfig: file }).timeoutMs).toBe(2_000);
    expect(
      resolveConfig({ envOverrides: env, fileConfig: file, callOverrides: call }).timeoutMs,
    ).toBe(3_000);
  });

  it("undefined fields in higher layers do not wipe lower-layer values", () => {
    const file: LimnUserConfig = { defaultModel: "claude-opus-4-7" };
    const call: LimnUserConfig = { timeoutMs: 99_000 }; // model not set
    const resolved = resolveConfig({ fileConfig: file, callOverrides: call });
    expect(resolved.defaultModel).toBe("claude-opus-4-7"); // file's wins
    expect(resolved.timeoutMs).toBe(99_000); // call's wins
  });
});

describe("envOverridesFromProcess", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty config when LIMN_TRACE_DIR is unset", () => {
    // stubEnv with `undefined` removes the variable for the duration of the
    // test and restores the prior value via vi.unstubAllEnvs() in afterEach.
    vi.stubEnv("LIMN_TRACE_DIR", undefined as unknown as string);
    expect(envOverridesFromProcess()).toEqual({});
  });

  it("returns empty config when LIMN_TRACE_DIR is empty", () => {
    vi.stubEnv("LIMN_TRACE_DIR", "");
    expect(envOverridesFromProcess()).toEqual({});
  });

  it("lifts LIMN_TRACE_DIR into trace.dir when set", () => {
    vi.stubEnv("LIMN_TRACE_DIR", "/tmp/limn-env-traces");
    const env = envOverridesFromProcess();
    expect(env.trace?.dir).toBe("/tmp/limn-env-traces");
  });
});
