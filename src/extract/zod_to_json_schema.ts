/**
 * Hand-rolled Zod 3 -> JSON Schema converter, scoped to the subset that
 * `ai.extract` exposes through the system prompt. The dependency policy
 * (CLAUDE.md hard rule #10) forbids adding `zod-to-json-schema` as a
 * runtime dep, so we ship the minimal converter ourselves.
 *
 * Supported shapes:
 *   - `z.string()` (with `.email()` / `.url()` / `.uuid()` format hints)
 *   - `z.number()`, `z.boolean()`
 *   - `z.literal(v)`, `z.enum([...])`
 *   - `z.array(inner)`
 *   - `z.union([a, b, ...])`
 *   - `z.optional(inner)` (only meaningful inside an object)
 *   - `z.object({ ... })` with nested recursion
 *
 * Anything outside this subset (records, intersections, transforms, lazy,
 * recursive types) falls back to `{ type: "object" }` so the model still
 * receives a hint rather than crashing the call. The fallback intentionally
 * widens the schema; users who hit it should narrow their schema or accept
 * the looser model output.
 *
 * Why so narrow: `ai.extract`'s job is to give the model a clear shape
 * description in the system prompt, not to faithfully roundtrip every
 * Zod feature into JSON Schema. The model never sees the converter output
 * literally; it sees a pretty-printed JSON snippet. Coverage of the common
 * shapes (objects, primitives, arrays, unions, enums, formatted strings) is
 * enough for the 80% extraction case.
 *
 * Lives in `src/extract/` (not `src/client/`) per the shared-helper-first
 * principle (CLAUDE.md §13.8): the converter is a pure utility that the
 * extract orchestration consumes; keeping it standalone lets future
 * tooling (e.g. an inspector schema viewer) depend on the same converter
 * without dragging in the client surface.
 */

import type { z } from "zod";

/** JSON Schema subset emitted by the converter. Intentionally loose. */
export type JsonSchema = Record<string, unknown>;

/**
 * Convert a Zod 3 schema to a JSON Schema object. Returns `{ type: "object" }`
 * for any shape outside the documented subset; the model still gets a hint.
 *
 * `unknown` rather than `z.ZodTypeAny` on the input so the converter never
 * leaks Zod type errors out of `src/extract/`. Internal access uses
 * `_def.typeName` (Zod 3's introspection seam); the cast lives in this one
 * spot rather than fanning out across the file.
 */
export function zodToJsonSchema(schema: unknown): JsonSchema {
  // Zod 3 stores discriminator metadata under `_def`. We narrow by reading
  // `typeName` (a string literal in Zod's type-tag enum) and treat anything
  // unrecognized as the wide-fallback case.
  const def = (schema as { _def?: { typeName?: string } })._def;
  if (def === undefined || typeof def.typeName !== "string") {
    return { type: "object" };
  }

  switch (def.typeName) {
    case "ZodString": {
      // String checks live in `_def.checks` as `{ kind: "email" | "url" | ...}`.
      const checks = (def as { checks?: ReadonlyArray<{ kind: string }> }).checks ?? [];
      for (const check of checks) {
        if (check.kind === "email") return { type: "string", format: "email" };
        if (check.kind === "url") return { type: "string", format: "uri" };
        if (check.kind === "uuid") return { type: "string", format: "uuid" };
      }
      return { type: "string" };
    }
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodLiteral": {
      const value = (def as { value?: unknown }).value;
      return { const: value };
    }
    case "ZodEnum": {
      const values = (def as { values?: readonly unknown[] }).values ?? [];
      return { enum: [...values] };
    }
    case "ZodArray": {
      const inner = (def as { type?: unknown }).type;
      return { type: "array", items: zodToJsonSchema(inner) };
    }
    case "ZodUnion": {
      const opts = (def as { options?: readonly unknown[] }).options ?? [];
      return { anyOf: opts.map((o) => zodToJsonSchema(o)) };
    }
    case "ZodOptional": {
      // Optional unwraps to its inner schema; the `required` list in the
      // enclosing object is where "optional-ness" is recorded.
      const inner = (def as { innerType?: unknown }).innerType;
      return zodToJsonSchema(inner);
    }
    case "ZodObject": {
      // Zod 3 stores object shape under `_def.shape()` (a function). Calling
      // it once gives the field map; we walk it and split required vs
      // optional based on each field's `_def.typeName`.
      const shapeFn = (def as { shape?: () => Record<string, z.ZodTypeAny> }).shape;
      const shape = typeof shapeFn === "function" ? shapeFn() : {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(field);
        const fieldDef = (field as { _def?: { typeName?: string } })._def;
        if (fieldDef?.typeName !== "ZodOptional") required.push(key);
      }
      return { type: "object", properties, required };
    }
    default:
      // Wide fallback: unknown shape becomes a generic object hint. The model
      // still produces JSON; the parser surfaces any mismatch as a
      // SchemaValidationError at the boundary.
      return { type: "object" };
  }
}
