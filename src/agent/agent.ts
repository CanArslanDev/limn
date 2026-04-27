/**
 * Agent factory. Phase 3 placeholder; the real multi-turn loop, tool dispatch,
 * and error-handler dispatch lands once Layer 1 is settled.
 */

import type { ModelName } from "../providers/model_name.js";
import type { RegisteredTool } from "./tool.js";

export interface AgentOptions {
  readonly model: ModelName;
  readonly tools?: readonly RegisteredTool[];
  readonly system?: string;
  readonly maxTurns?: number;
  readonly onError?: AgentErrorHandlers;
}

export interface AgentErrorHandlers {
  readonly RateLimitError?: { readonly retry: "exponential" | "linear"; readonly max: number };
  readonly ToolExecutionError?: { readonly retry: "once" | "never" };
  readonly SchemaValidationError?: { readonly retry: "once" | "never" };
}

export interface Agent {
  run(prompt: string): Promise<AgentResult>;
}

export interface AgentResult {
  readonly output: string;
  readonly turns: number;
  readonly traceId: string;
}

export function agent(_options: AgentOptions): Agent {
  return {
    async run(_prompt) {
      throw new Error("ai.agent().run is not implemented yet (Phase 3).");
    },
  };
}
