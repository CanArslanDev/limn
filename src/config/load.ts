/**
 * Project-config discovery + load. Walks `process.cwd()` for the first
 * `limn.config.{ts,mts,js,mjs,cjs}` file and `require()`s it through
 * `node:module.createRequire` so the user can author the config in
 * CommonJS or any format their runtime understands.
 *
 * .ts and .mts extensions are discovered alongside .js/.mjs/.cjs but only
 * load when the host runtime has TypeScript support installed (tsx,
 * ts-node, Node 22+ with `--experimental-strip-types`, ...). Without such
 * support `require()` raises a `SyntaxError` which we surface as a
 * `ConfigLoadError` carrying the absolute path; the recommended fallback
 * for users without a TS loader is a `.js`/`.cjs` config (annotated with
 * `defineConfig` for IntelliSense via JSDoc on the export).
 *
 * Cached: subsequent `loadProjectConfig()` calls return the cached value
 * (the resolved object OR a sentinel for "no config found") without
 * re-reading the filesystem. Tests reset the cache via
 * `__resetConfigCacheForTests()` between runs because each test file may
 * `process.chdir()` into a fresh tmp dir.
 *
 * Why `createRequire(cwd + "/")` rather than the bare `cwd`: `createRequire`
 * needs a "from" path to anchor relative resolution. A trailing slash makes
 * Node treat the cwd as a directory rather than a sibling file.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ConfigLoadError } from "../errors/index.js";
import type { LimnUserConfig } from "./define_config.js";

/**
 * Discovery order. Earlier entries win when multiple config files exist
 * (Limn warns rather than guessing - see TODO below). The order favors
 * the formats most users author by hand: `.ts` first because TypeScript
 * users are the dominant consumer, then `.mts` for the same reason in an
 * ESM-heavy project, then the JavaScript fallbacks.
 */
const CONFIG_EXTENSIONS = ["ts", "mts", "js", "mjs", "cjs"] as const;

type CacheEntry = { readonly value: LimnUserConfig | undefined };

let cached: CacheEntry | undefined;

/**
 * Discover and load `limn.config.{ts,mts,js,mjs,cjs}` from the current
 * working directory. Returns the parsed user config, or `undefined` when
 * no config file is present. Throws `ConfigLoadError` (carrying the
 * absolute path) if a candidate is found but fails to load.
 *
 * The result is cached process-wide for performance: repeated lookups
 * during a long-running app (e.g. an Express server doing per-request
 * `ai.ask` calls) hit a single `Map` lookup. The cache is keyed only on
 * the load result, not on cwd; tests that change cwd MUST call
 * `__resetConfigCacheForTests()` to avoid leaking state across files.
 */
export function loadProjectConfig(): LimnUserConfig | undefined {
  if (cached !== undefined) return cached.value;
  const cwd = process.cwd();
  for (const ext of CONFIG_EXTENSIONS) {
    const candidate = resolve(cwd, `limn.config.${ext}`);
    if (!existsSync(candidate)) continue;
    try {
      // `createRequire` is anchored on a directory by passing a
      // trailing-slashed path; `require(absolutePath)` then loads the file
      // through Node's CommonJS resolver (which transparently handles ESM
      // when given a `.mjs` extension on Node >= 20).
      const req = createRequire(`${cwd}/`);
      // Bust Node's CommonJS module cache for this file so a long-running
      // process that reloads the config (or, more importantly, a test that
      // calls `__resetConfigCacheForTests` and then writes new contents to
      // the same path) sees the fresh contents. Without this, `require()`
      // returns the previously-loaded object regardless of file changes.
      const cacheKey = req.resolve(candidate);
      delete req.cache[cacheKey];
      const mod = req(candidate) as { default?: LimnUserConfig } | LimnUserConfig;
      // Default-export interop: a `module.exports = { default: { ... } }`
      // shape (typical for a TypeScript file compiled with `esModuleInterop`)
      // unwraps once. Plain CommonJS exports surface directly.
      const value = (
        typeof mod === "object" && mod !== null && "default" in mod && mod.default !== undefined
          ? mod.default
          : mod
      ) as LimnUserConfig;
      cached = { value };
      return value;
    } catch (err) {
      throw new ConfigLoadError(
        `Failed to load ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
        candidate,
        err,
      );
    }
  }
  // Cache the negative result so subsequent lookups in the same process do
  // not re-scan the directory. Tests that need a fresh discovery (e.g.
  // after writing a new config file) call `__resetConfigCacheForTests()`.
  cached = { value: undefined };
  return undefined;
}

/**
 * Test-only seam to reset the load cache between tests. Production code
 * never imports this; the leading underscores are a convention for
 * "internal escape hatch". A real long-running application would not need
 * to reset the cache (the config file is by convention immutable for the
 * process lifetime).
 */
export function __resetConfigCacheForTests(): void {
  cached = undefined;
}
