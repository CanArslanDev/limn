/**
 * Tool factory. The user-facing way to register a callable for an agent loop.
 *
 *   const search = tool({
 *     name: "search",
 *     description: "Search the web",
 *     input: z.object({ query: z.string() }),
 *     run: async ({ query }) => fetch(...)
 *   })
 *
 * The factory normalizes the Zod schema into a JSON-Schema document for the
 * provider, and produces a `RegisteredTool` whose `run` accepts the raw model
 * payload and validates before forwarding to the user callback.
 */

import type { z } from "zod";

export interface ToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodSchema<TInput>;
  readonly run: (input: TInput) => Promise<TOutput> | TOutput;
}

export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputJsonSchema: Record<string, unknown>;
  invoke(rawInput: unknown): Promise<unknown>;
}

export function tool<TInput, TOutput>(
  def: ToolDefinition<TInput, TOutput>,
): RegisteredTool {
  return {
    name: def.name,
    description: def.description,
    // Phase 1 placeholder - full Zod -> JSON Schema conversion lands later.
    inputJsonSchema: { type: "object" },
    async invoke(rawInput) {
      const parsed = def.input.parse(rawInput);
      return def.run(parsed);
    },
  };
}
