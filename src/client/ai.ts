/**
 * The `ai` namespace - Layer 1 entry point. Phase 1 placeholder; the real
 * orchestration (provider dispatch, retries, tracing) lands as the layers
 * underneath fill in.
 *
 * Shape locked here so the rest of the package can import a stable surface.
 */

import type { z } from "zod";
import type {
  AskOptions,
  ChatMessage,
  ChatOptions,
  ExtractOptions,
  StreamOptions,
} from "./options.js";

export interface Ai {
  ask(prompt: string, options?: AskOptions): Promise<string>;
  ask(prompt: string, context: string, options?: AskOptions): Promise<string>;

  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string>;

  extract<T>(
    schema: z.ZodSchema<T>,
    input: string,
    options?: ExtractOptions,
  ): Promise<T>;

  stream(prompt: string, options?: StreamOptions): AsyncIterable<string>;

  agent: typeof import("../agent/agent.js").agent;
}

const notImplemented = (fn: string): never => {
  throw new Error(`ai.${fn} is not implemented yet (Phase 1).`);
};

export const ai: Ai = {
  async ask(_prompt, _contextOrOptions, _maybeOptions) {
    return notImplemented("ask");
  },

  async chat(_messages, _options) {
    return notImplemented("chat");
  },

  async extract(_schema, _input, _options) {
    return notImplemented("extract");
  },

  // eslint-disable-next-line require-yield
  async *stream(_prompt, _options) {
    notImplemented("stream");
  },

  // Lazy property avoids circular-import surprise at module init.
  get agent() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    return require("../agent/agent.js").agent;
  },
};
