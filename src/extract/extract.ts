/**
 * Orchestration helper for `ai.extract`. Builds the system prompt that asks
 * the model to emit JSON matching a Zod schema, parses the response, and
 * (when `retryOnSchemaFailure: true`) feeds the validation error back to the
 * model for one corrective attempt.
 *
 * The chat call itself is injected via the `callChat` parameter so the
 * extract layer never imports back into `src/client/`. This avoids a
 * circular dependency: the public `ai.extract` lives in `src/client/ai.ts`
 * and constructs the chat callback by reusing its own `ai.chat`
 * implementation, which sits beside it.
 *
 * Design notes:
 *   - The system prompt instructs "JSON only, no prose, no fences". A real
 *     model may still emit code fences or leading explanation; the parser
 *     is tolerant of a leading/trailing ```json fence (stripped) but does
 *     not attempt to recover from arbitrary prose. Failure surfaces as
 *     `SchemaValidationError` with `actualPayload` set to whatever JSON
 *     parsed (or `null` if the string is not JSON at all).
 *   - The retry flow appends an `assistant` message with the previous
 *     response and a `user` message naming the validation problem, then
 *     re-issues the chat call. The model sees its own output and the
 *     Zod error message; one attempt is the documented cap.
 *   - `expectedSchemaName` is read from `schema.description` (set via
 *     `schema.describe("Person")`) when present; otherwise it falls back
 *     to the typeName from `_def`, then to `"Schema"`. The inspector
 *     surfaces this so users can correlate failures with their schemas.
 */

import type { z } from "zod";
import type { ChatMessage } from "../client/options.js";
import { SchemaValidationError } from "../errors/index.js";
import { type JsonSchema, zodToJsonSchema } from "./zod_to_json_schema.js";

/**
 * Shape of the chat callback the extract orchestration depends on. The
 * caller (see `src/client/ai.ts`) passes a thin closure that delegates to
 * `ai.chat` and returns the assistant content as a string. Keeping this as
 * a callback (rather than a direct import) avoids a circular dep between
 * `src/extract/` and `src/client/`.
 */
export type ExtractChatFn = (messages: readonly ChatMessage[]) => Promise<string>;

export interface RunExtractOptions {
  readonly retryOnSchemaFailure?: boolean;
}

/**
 * Run the extract flow. Returns the parsed result on success; throws
 * `SchemaValidationError` on validation failure (after retry, if enabled).
 *
 * The schema is typed as `z.ZodSchema<T>`; the public `ai.extract` declares
 * the same shape so consumers get inference without thinking about Zod's
 * internals. Inside this function the schema's `.safeParse` is the only
 * surface we touch.
 */
export async function runExtract<T>(
  schema: z.ZodSchema<T>,
  input: string,
  callChat: ExtractChatFn,
  options: RunExtractOptions = {},
): Promise<T> {
  const jsonSchema = zodToJsonSchema(schema);
  const schemaName = describeSchemaName(schema);
  const systemPrompt = buildSystemPrompt(jsonSchema);

  const firstMessages: readonly ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input },
  ];

  const firstResponse = await callChat(firstMessages);
  const firstParsed = tryParseJson(firstResponse);
  const firstResult = schema.safeParse(firstParsed);
  if (firstResult.success) return firstResult.data;

  if (options.retryOnSchemaFailure !== true) {
    throw new SchemaValidationError(
      `Model response did not match schema "${schemaName}".`,
      schemaName,
      firstParsed,
      firstResult.error,
    );
  }

  // One retry: feed the model its own output plus the validation problem.
  // The corrective user message names the schema and the Zod error so the
  // model knows what to fix.
  const retryMessages: readonly ChatMessage[] = [
    ...firstMessages,
    { role: "assistant", content: firstResponse },
    {
      role: "user",
      content: `Your previous response did not match the schema "${schemaName}". Validation error: ${firstResult.error.message}. Return ONLY valid JSON matching the schema; no prose, no fences.`,
    },
  ];

  const secondResponse = await callChat(retryMessages);
  const secondParsed = tryParseJson(secondResponse);
  const secondResult = schema.safeParse(secondParsed);
  if (secondResult.success) return secondResult.data;

  throw new SchemaValidationError(
    `Model response did not match schema "${schemaName}" after retry.`,
    schemaName,
    secondParsed,
    secondResult.error,
  );
}

/**
 * Build the system prompt that asks the model to return JSON matching the
 * supplied schema. Pretty-printed so the model sees the structure clearly;
 * the trailing instructions are explicit because some models prefer prose
 * preambles otherwise.
 */
function buildSystemPrompt(jsonSchema: JsonSchema): string {
  const pretty = JSON.stringify(jsonSchema, null, 2);
  return [
    "You must respond with ONLY a valid JSON object matching this schema:",
    pretty,
    "",
    "No prose, no markdown, no code fences. Just the JSON object.",
  ].join("\n");
}

/**
 * Extract a human-readable name for the schema. Prefers `schema.description`
 * (set via `schema.describe("Person")`) so users can pin a name; falls back
 * to the Zod type name from `_def.typeName` (e.g. `"ZodObject"`); ultimately
 * defaults to `"Schema"`.
 */
function describeSchemaName(schema: unknown): string {
  const def = (schema as { _def?: { typeName?: string; description?: string } })._def;
  if (def === undefined) return "Schema";
  // `.describe("Person")` lands on `_def.description` in Zod 3.
  if (typeof def.description === "string" && def.description.length > 0) return def.description;
  if (typeof def.typeName === "string") return def.typeName;
  return "Schema";
}

/**
 * Parse a model response into JSON. Tolerates a leading/trailing
 * ```json``` code fence (some models add it despite explicit instructions
 * not to). Returns `null` for unparseable input so the caller can surface
 * the original string as `actualPayload` on `SchemaValidationError`.
 */
function tryParseJson(raw: string): unknown {
  const stripped = stripCodeFence(raw).trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Strip a leading ````json` (or bare `````) fence and the matching closing
 * fence, if both are present. No-op when there is no fence; no-op when only
 * one side has a fence (a malformed response is the user's problem to
 * surface, not ours to silently coerce).
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const openFence = trimmed.match(/^```(?:json)?\s*\n/);
  if (openFence === null) return raw;
  const withoutOpen = trimmed.slice(openFence[0].length);
  const closeIdx = withoutOpen.lastIndexOf("```");
  if (closeIdx === -1) return raw;
  return withoutOpen.slice(0, closeIdx);
}
