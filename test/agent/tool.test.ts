/**
 * Tool factory contract. The factory normalizes a Zod schema into a
 * provider-friendly shape, and the resulting `RegisteredTool.invoke` parses
 * raw model input through the schema before dispatching to the user
 * callback.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tool } from "../../src/agent/tool.js";

describe("tool factory", () => {
  it("returns a registered tool with name + description", () => {
    const t = tool({
      name: "search",
      description: "Search the web",
      input: z.object({ query: z.string() }),
      run: async ({ query }) => ({ query, hits: 0 }),
    });

    expect(t.name).toBe("search");
    expect(t.description).toBe("Search the web");
  });

  it("parses raw input through the Zod schema before invoking run", async () => {
    let receivedQuery = "";
    const t = tool({
      name: "search",
      description: "Search the web",
      input: z.object({ query: z.string() }),
      run: async ({ query }) => {
        receivedQuery = query;
        return { ok: true };
      },
    });

    await t.invoke({ query: "rlhf" });
    expect(receivedQuery).toBe("rlhf");
  });

  it("throws a Zod error when raw input violates the schema", async () => {
    const t = tool({
      name: "search",
      description: "Search the web",
      input: z.object({ query: z.string() }),
      run: async () => ({ ok: true }),
    });

    await expect(t.invoke({ query: 42 })).rejects.toThrow();
  });
});
