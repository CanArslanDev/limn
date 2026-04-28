/**
 * The `ai` namespace - Layer 1 entry point. Phase 1 placeholder; the real
 * orchestration (provider dispatch, retries, tracing) lands as the layers
 * underneath fill in.
 *
 * Shape locked here so the rest of the package can import a stable surface.
 */

import type { z } from "zod";
import { agent } from "../agent/agent.js";
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

  extract<T>(schema: z.ZodSchema<T>, input: string, options?: ExtractOptions): Promise<T>;

  stream(prompt: string, options?: StreamOptions): AsyncIterable<string>;

  readonly agent: typeof agent;
}

const notImplemented = (fn: string): never => {
  throw new Error(`ai.${fn} is not implemented yet (Phase 1).`);
};

export const ai: Ai = {
  async ask(_prompt: string, _contextOrOptions?: string | AskOptions, _maybeOptions?: AskOptions) {
    return notImplemented("ask");
  },

  async chat(_messages, _options) {
    return notImplemented("chat");
  },

  async extract(_schema, _input, _options) {
    return notImplemented("extract");
  },

  stream(_prompt, _options) {
    throw new Error("ai.stream is not implemented yet (Phase 1).");
  },

  agent,
};
