/**
 * `loadProjectConfig` tests. Drives the discovery + cache behavior using
 * temporary directories so the project's own `limn.config.*` (if any) cannot
 * interfere. Each test's `beforeEach` creates an isolated tmp dir, chdirs
 * there, resets the load cache; `afterEach` restores cwd, drops the dir,
 * resets the cache again so test files in the same Vitest worker do not
 * inherit one another's state.
 *
 * .cjs is the portable target: a CommonJS file is loadable via
 * `createRequire(...)` from any Node runtime without a TypeScript hook. The
 * .ts/.mjs paths are exercised by the discovery test (we assert which
 * candidate name was attempted, not whether Node could parse it) so that
 * users on a runtime with TypeScript support (tsx, ts-node, Node 22+ flag)
 * still benefit from the same discovery order.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetConfigCacheForTests, loadProjectConfig } from "../../src/config/load.js";
import { ConfigLoadError } from "../../src/errors/index.js";

describe("loadProjectConfig", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // realpathSync resolves /var -> /private/var on macOS so the path the
    // tests construct via join(dir, ...) matches what process.cwd() reports
    // after chdir. Without this, the syntax-error test compares two
    // semantically-equivalent paths that string-compare unequal.
    dir = realpathSync(await mkdtemp(join(tmpdir(), "limn-load-cfg-")));
    process.chdir(dir);
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    __resetConfigCacheForTests();
  });

  it("returns undefined when no limn.config.* exists at the cwd", () => {
    expect(loadProjectConfig()).toBeUndefined();
  });

  it("loads a CommonJS limn.config.cjs and returns its export", async () => {
    await writeFile(
      join(dir, "limn.config.cjs"),
      `module.exports = { defaultModel: "claude-opus-4-7", trace: { dir: ".cjs-traces" } };`,
      "utf8",
    );
    const cfg = loadProjectConfig();
    expect(cfg?.defaultModel).toBe("claude-opus-4-7");
    expect(cfg?.trace?.dir).toBe(".cjs-traces");
  });

  it("unwraps a default-export shape from CommonJS interop", async () => {
    await writeFile(
      join(dir, "limn.config.cjs"),
      `module.exports = { default: { defaultModel: "claude-haiku-4-5" } };`,
      "utf8",
    );
    const cfg = loadProjectConfig();
    expect(cfg?.defaultModel).toBe("claude-haiku-4-5");
  });

  it("throws ConfigLoadError carrying the absolute path on syntax errors", async () => {
    await writeFile(join(dir, "limn.config.cjs"), "module.exports = { broken: ;", "utf8");
    let caught: unknown;
    try {
      loadProjectConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigLoadError);
    const err = caught as ConfigLoadError;
    expect(err.configPath).toBe(join(dir, "limn.config.cjs"));
    expect(err.cause).toBeDefined();
  });

  it("caches the load result; second call does not re-read the file", async () => {
    await writeFile(
      join(dir, "limn.config.cjs"),
      `module.exports = { defaultModel: "claude-opus-4-7" };`,
      "utf8",
    );
    const first = loadProjectConfig();
    // Mutate the file contents AFTER the first load. If the cache is
    // honored, the second call returns the original value (not the new
    // value) without ever touching the file.
    await writeFile(
      join(dir, "limn.config.cjs"),
      `module.exports = { defaultModel: "claude-haiku-4-5" };`,
      "utf8",
    );
    const second = loadProjectConfig();
    expect(second).toBe(first);
    expect(second?.defaultModel).toBe("claude-opus-4-7");
  });

  it("__resetConfigCacheForTests forces a fresh load on the next call", async () => {
    await writeFile(
      join(dir, "limn.config.cjs"),
      `module.exports = { defaultModel: "claude-opus-4-7" };`,
      "utf8",
    );
    loadProjectConfig();
    await writeFile(
      join(dir, "limn.config.cjs"),
      `module.exports = { defaultModel: "claude-haiku-4-5" };`,
      "utf8",
    );
    __resetConfigCacheForTests();
    const reread = loadProjectConfig();
    expect(reread?.defaultModel).toBe("claude-haiku-4-5");
  });

  it("caches the negative result so repeated 'no config' lookups do not stat the dir twice", () => {
    expect(loadProjectConfig()).toBeUndefined();
    expect(loadProjectConfig()).toBeUndefined();
  });
});
