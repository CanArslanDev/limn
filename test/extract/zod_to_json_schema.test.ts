/**
 * Unit tests for the hand-rolled `zodToJsonSchema` converter. The converter
 * supports the subset of Zod 3 shapes documented in `guides/api-surface.md`:
 * primitives, objects, arrays, optional, union, literal, enum, and the common
 * string formats (email, url, uuid). Anything outside the subset falls
 * through to `{ type: "object" }` so the model still receives a hint rather
 * than crashing the call.
 *
 * The dependency-policy ban on adding `zod-to-json-schema` (CLAUDE.md hard
 * rule #10) makes this converter load-bearing. Each shape gets one focused
 * assertion so a future Zod-major upgrade fails noisily with a precise
 * pointer at the broken arm.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../../src/extract/zod_to_json_schema.js";

describe("zodToJsonSchema", () => {
  it("encodes z.string() as { type: 'string' }", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
  });

  it("encodes z.number() as { type: 'number' }", () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
  });

  it("encodes z.boolean() as { type: 'boolean' }", () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  it("encodes z.string().email() with a format hint", () => {
    expect(zodToJsonSchema(z.string().email())).toEqual({ type: "string", format: "email" });
  });

  it("encodes z.string().url() with a format hint", () => {
    expect(zodToJsonSchema(z.string().url())).toEqual({ type: "string", format: "uri" });
  });

  it("encodes z.string().uuid() with a format hint", () => {
    expect(zodToJsonSchema(z.string().uuid())).toEqual({ type: "string", format: "uuid" });
  });

  it("encodes z.literal('foo') as { const: 'foo' }", () => {
    expect(zodToJsonSchema(z.literal("foo"))).toEqual({ const: "foo" });
  });

  it("encodes z.enum([...]) as { enum: [...] }", () => {
    expect(zodToJsonSchema(z.enum(["red", "green", "blue"]))).toEqual({
      enum: ["red", "green", "blue"],
    });
  });

  it("encodes z.array(z.string()) as { type: 'array', items: { type: 'string' } }", () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("encodes z.union([...]) as { anyOf: [...] }", () => {
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("encodes z.object({...}) with required fields", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
  });

  it("encodes z.object with z.optional() fields excluded from required", () => {
    const schema = z.object({ name: z.string(), nickname: z.string().optional() });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { name: { type: "string" }, nickname: { type: "string" } },
      required: ["name"],
    });
  });

  it("recurses into nested objects", () => {
    const schema = z.object({
      user: z.object({ name: z.string(), email: z.string().email() }),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { name: { type: "string" }, email: { type: "string", format: "email" } },
          required: ["name", "email"],
        },
      },
      required: ["user"],
    });
  });

  it("falls back to { type: 'object' } for unsupported Zod shapes", () => {
    // z.any() is intentionally outside the supported subset; the converter
    // must degrade gracefully so calls keep working with a wide hint.
    expect(zodToJsonSchema(z.any())).toEqual({ type: "object" });
  });
});
