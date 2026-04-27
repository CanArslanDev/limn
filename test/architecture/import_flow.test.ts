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

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..", "src");

interface LayerRule {
  readonly layer: string;
  /** Path prefixes the layer is allowed to import from (relative to src/). */
  readonly mayImportFrom: readonly string[];
}

const LAYER_RULES: readonly LayerRule[] = [
  { layer: "errors", mayImportFrom: [] },
  { layer: "trace", mayImportFrom: [] },
  {
    layer: "providers/model_name.ts",
    mayImportFrom: [],
  },
  {
    layer: "providers/provider.ts",
    mayImportFrom: ["providers/model_name", "client/options"],
  },
  {
    layer: "providers/registry.ts",
    mayImportFrom: ["providers/model_name", "providers/provider"],
  },
  {
    layer: "providers/anthropic",
    mayImportFrom: ["providers/provider", "providers/model_name", "errors"],
  },
  {
    layer: "providers/openai",
    mayImportFrom: ["providers/provider", "providers/model_name", "errors"],
  },
  {
    layer: "config",
    mayImportFrom: ["providers/model_name"],
  },
  {
    layer: "agent",
    mayImportFrom: ["providers/model_name", "errors"],
  },
  {
    layer: "client",
    mayImportFrom: ["providers", "agent", "config", "trace", "errors"],
  },
  {
    layer: "inspect",
    mayImportFrom: ["trace"],
  },
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

describe("architecture: unidirectional import flow", () => {
  it("every src/ file's relative imports stay within its layer's allowance", async () => {
    const files = await walkTs(SRC);
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      const rule = LAYER_RULES.find((r) => rel.startsWith(r.layer));
      if (!rule) continue;

      const source = await readFile(file, "utf8");
      const imports = importPathsFrom(source).filter((i) => i.startsWith("."));

      for (const imp of imports) {
        const normalized = imp.replace(/\.\.\//g, "").replace(/^\.\//, "").replace(/\.js$/, "");
        const ok = rule.mayImportFrom.some((allowed) =>
          normalized.startsWith(allowed),
        );
        const sameLayer = normalized.startsWith(rule.layer.replace(/\.ts$/, ""));
        if (!ok && !sameLayer) {
          violations.push(`${rel}\n  imports ${imp}\n  layer "${rule.layer}" may import from: ${rule.mayImportFrom.join(", ") || "(nothing)"}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
