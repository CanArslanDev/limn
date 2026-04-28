import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "examples"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      // Phase 0 scaffold: placeholder files that throw "not implemented yet"
      // are excluded from coverage until their Phase 1 batch lands. Each batch
      // removes the file it implements from this list and tightens the
      // thresholds below. By end of Phase 1 batch 1.4, all entries here are
      // gone and thresholds return to 80 / 80 / 75 / 80.
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts",
        "src/cli/**",
        "src/inspect/**",
        // Phase 1 placeholders, removed as their batches land:
        "src/client/options.ts", // batch 1.1 (types only; covered via usage)
        "src/agent/agent.ts", // Phase 3
        "src/providers/provider.ts", // batch 1.1 (types only; covered via usage)
        "src/providers/anthropic/**", // batch 1.2
        "src/providers/openai/**", // batch 1.6
        "src/trace/**", // batch 1.4
      ],
      // Phase 0 baseline. Bumped each batch in lockstep with the exclude
      // shrinkage above. Plan target by end of Phase 1: 80 / 75 / 80 / 80.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
