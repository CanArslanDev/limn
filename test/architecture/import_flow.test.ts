/**
 * Architecture invariants. Imports flow only downward:
 *
 *   index -> client -> agent
 *                  -> providers -> SDK
 *                  -> trace
 *                  -> config
 *                  -> errors
 *
 * Errors and trace are leaves: they import from nothing under src/. config
 * imports only from providers/model_name. Providers import only from each
 * other (model_name, provider, registry) and from errors. Client and agent
 * may import from anything below them.
 *
 * Adding a new layer: extend the relevant LAYER_RULES entry in the same
 * commit. Relaxing an invariant without an explicit replacement guard is a
 * bug.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");

interface LayerRule {
  /** Glob-style path prefix (relative to src/) that selects files. */
  readonly layer: string;
  /** Sibling layers this layer is allowed to import from (relative to src/). */
  readonly mayImportFrom: readonly string[];
}

/**
 * Each rule's `layer` is matched as a prefix against the file's path relative
 * to `src/`. A file is *always* allowed to import from inside its own layer
 * (its own directory or its own file). `mayImportFrom` lists the *other*
 * layers it may reach into.
 *
 * `errors/` is the entire errors directory. `providers/model_name.ts` is a
 * single-file layer. `providers/anthropic` matches both adapter file and any
 * future helpers under that vendor.
 */
const LAYER_RULES: readonly LayerRule[] = [
  { layer: "index.ts", mayImportFrom: ["client", "agent", "config", "errors", "providers"] },
  { layer: "errors", mayImportFrom: [] },
  { layer: "trace", mayImportFrom: [] },
  { layer: "providers/model_name.ts", mayImportFrom: [] },
  { layer: "providers/provider.ts", mayImportFrom: ["providers", "client/options"] },
  { layer: "providers/registry.ts", mayImportFrom: ["providers", "errors"] },
  { layer: "providers/anthropic", mayImportFrom: ["providers", "errors", "client/options"] },
  { layer: "providers/openai", mayImportFrom: ["providers", "errors"] },
  { layer: "providers/_mock", mayImportFrom: ["providers", "errors"] },
  { layer: "config", mayImportFrom: ["providers/model_name"] },
  { layer: "agent", mayImportFrom: ["agent", "providers/model_name", "errors"] },
  {
    layer: "hooks",
    mayImportFrom: ["client/options", "providers/model_name", "config", "errors", "trace"],
  },
  {
    layer: "client",
    mayImportFrom: ["client", "providers", "agent", "config", "hooks", "trace", "errors"],
  },
  { layer: "inspect", mayImportFrom: ["trace"] },
  { layer: "cli", mayImportFrom: [] },
];

async function walkTs(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkTs(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function importPathsFrom(source: string): string[] {
  const re = /from\s+["']([^"']+)["']/g;
  const out: string[] = [];
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    if (match[1] !== undefined) {
      out.push(match[1]);
    }
    match = re.exec(source);
  }
  return out;
}

/**
 * Take a relative import like `../providers/model_name.js` originating in
 * `src/client/ai.ts`, resolve it against the importer's directory, then
 * return the path relative to `src/` with the `.js`/`.ts` suffix stripped.
 * Returns `null` if the import is not under `src/` (external module).
 */
function resolveImport(importerAbs: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) return null;
  const resolved = resolve(dirname(importerAbs), importPath);
  const rel = relative(SRC, resolved).replaceAll("\\", "/");
  if (rel.startsWith("..")) return null;
  return rel.replace(/\.js$/, "").replace(/\.ts$/, "");
}

describe("architecture: unidirectional import flow", () => {
  it("every src/ file's relative imports stay within its layer's allowance", async () => {
    const files = await walkTs(SRC);
    const violations: string[] = [];

    for (const file of files) {
      const relFile = relative(SRC, file).replaceAll("\\", "/");
      const rule = LAYER_RULES.find((r) => relFile.startsWith(r.layer));
      if (!rule) continue;

      const source = await readFile(file, "utf8");
      for (const raw of importPathsFrom(source)) {
        const target = resolveImport(file, raw);
        if (target === null) continue;

        const ownLayer = rule.layer.replace(/\.ts$/, "");
        const allowed =
          target.startsWith(ownLayer) ||
          rule.mayImportFrom.some((p) => target === p || target.startsWith(`${p}/`));

        if (!allowed) {
          violations.push(
            `${relFile}\n  imports ${raw}  (resolves to ${target})\n  layer "${rule.layer}" may import from: ${rule.mayImportFrom.join(", ") || "(nothing)"}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
