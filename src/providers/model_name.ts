/**
 * Branded model-name strings. Keeps typos out of the API surface: a literal
 * `"claude-opus-4-7"` widens to `string`; a `ModelName` only accepts values
 * the providers know about.
 *
 * Adding a new model means extending this union AND mapping it in the
 * appropriate provider's `models()` table.
 */

export type AnthropicModel =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export type OpenAIModel =
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4-turbo"
  | "o1-preview"
  | "o1-mini";

export type ModelName = AnthropicModel | OpenAIModel;

export const ANTHROPIC_MODELS: readonly AnthropicModel[] = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

export const OPENAI_MODELS: readonly OpenAIModel[] = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "o1-preview",
  "o1-mini",
] as const;

export const DEFAULT_MODEL: ModelName = "claude-sonnet-4-6";
