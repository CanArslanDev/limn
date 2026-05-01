/**
 * End-to-end resolution-chain smoke. Drives `ai.ask` against a
 * MockProvider with a `traceworks.config.cjs` written to a tmp dir; asserts
 * that the per-call trace lands in the directory the config file
 * specified, proving the file layer of the resolution chain takes
 * effect against the production wiring.
 *
 * Why a chdir-based tmp dir rather than injecting the config: the whole
 * point of `loadProjectConfig` is to discover a file at the cwd. The
 * smoke test exercises the discovery + load + merge + dispatcher-config
 * pipeline end-to-end. The simple_api_smoke covers the no-config path;
 * this test covers the file-config path.
 *
 * RED -> GREEN target for batch 1.8.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ai } from "../../src/client/ai.js";
import { __resetConfigCacheForTests } from "../../src/config/load.js";
import { MockProvider } from "../../src/providers/_mock/mock_provider.js";
import { getProvider, registerProvider, unregisterProvider } from "../../src/providers/registry.js";

describe("ai.ask + traceworks.config.cjs (resolution chain)", () => {
  let projectDir: string;
  let traceDir: string;
  let originalCwd: string;
  let mock: MockProvider;
  let previous: ReturnType<typeof getProvider> | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // realpathSync resolves macOS's /var -> /private/var symlink so cwd
    // matches the path we pass to the config file.
    projectDir = realpathSync(await mkdtemp(join(tmpdir(), "traceworks-cfg-int-")));
    traceDir = realpathSync(await mkdtemp(join(tmpdir(), "traceworks-cfg-trace-")));
    process.chdir(projectDir);
    __resetConfigCacheForTests();

    try {
      previous = getProvider("anthropic");
    } catch {
      previous = undefined;
    }
    mock = new MockProvider("anthropic");
    registerProvider("anthropic", mock);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    __resetConfigCacheForTests();
    mock.reset();
    if (previous !== undefined) {
      registerProvider("anthropic", previous);
    } else {
      unregisterProvider("anthropic");
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(traceDir, { recursive: true, force: true });
  });

  it("honors trace.dir set by traceworks.config.cjs (file layer wins over default)", async () => {
    // Escape the path for embedding in the CommonJS source. Backslashes
    // would break on Windows; this test runs on POSIX-ish runners (CI is
    // Linux + macOS) but the JSON.stringify quoting is portable.
    const cfgSource = `module.exports = { trace: { dir: ${JSON.stringify(traceDir)} } };`;
    await writeFile(join(projectDir, "traceworks.config.cjs"), cfgSource, "utf8");

    mock.pushResponse({
      content: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await ai.ask("hi");

    // Trace should land in the dir from the config file, NOT in
    // .traceworks/traces (the DEFAULT_CONFIG fallback).
    const traces = (await readdir(traceDir)).filter((n) => n.endsWith(".json"));
    expect(traces).toHaveLength(1);
  });
});
