import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "agent/index": "src/agent/index.ts",
    "inspect/index": "src/inspect/index.ts",
    "errors/index": "src/errors/index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "node20",
  outDir: "dist",
  platform: "node",
  external: ["@anthropic-ai/sdk", "openai"],
});
