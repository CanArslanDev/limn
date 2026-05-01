/**
 * Limn - TypeScript-first library for building, debugging, and operating LLM
 * applications.
 *
 * Public surface:
 *   - `ai`           : Layer 1 entry point (`ask`, `chat`, `extract`, `stream`).
 *   - `tool`         : Layer 2 tool factory.
 *   - `defineConfig` : Project-level configuration helper.
 *
 * Submodules (`limn/agent`, `limn/inspect`, `limn/errors`) are exported for
 * tree-shaking but are not required.
 */

export { ai } from "./client/ai.js";
export { tool } from "./agent/tool.js";
export { defineConfig } from "./config/define_config.js";

export type {
  AskOptions,
  Attachment,
  ChatOptions,
  ChatMessage,
  ExtractOptions,
  ImageAttachment,
  ImageSource,
  StreamOptions,
  SupportedImageMimeType,
} from "./client/options.js";

export type { LimnConfig } from "./config/limn_config.js";
export type { ModelName } from "./providers/model_name.js";
export type { RegisteredTool, ToolDefinition } from "./agent/tool.js";

export {
  AnthropicProvider,
  type AnthropicProviderOptions,
} from "./providers/anthropic/anthropic_provider.js";

export {
  OpenAIProvider,
  type OpenAIProviderOptions,
} from "./providers/openai/openai_provider.js";

export {
  AuthError,
  ConfigLoadError,
  LimnError,
  ModelTimeoutError,
  ProviderError,
  RateLimitError,
  SchemaValidationError,
  ToolExecutionError,
} from "./errors/index.js";

export type { LimnUserConfig } from "./config/define_config.js";
