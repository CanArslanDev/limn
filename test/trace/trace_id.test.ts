/**
 * Unit tests for the trace-ID + ULID helpers. Covers the trace-ID format,
 * the ULID alphabet + length, the timestamp prefix sortability, and the
 * randomness segment uniqueness.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { newTraceId, newUlid } from "../../src/trace/trace_id.js";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

afterEach(() => {
  vi.useRealTimers();
});

describe("newTraceId", () => {
  it("returns a string prefixed with 'trc_'", () => {
    const id = newTraceId();
    expect(id.startsWith("trc_")).toBe(true);
  });

  it("contains a UUID body after the prefix", () => {
    const id = newTraceId();
    const body = id.slice(4);
    // Standard UUID v4 shape: 8-4-4-4-12 hex chars.
    expect(body).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns a fresh ID on each call", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
  });
});

describe("newUlid", () => {
  it("returns a 26-character string", () => {
    expect(newUlid()).toHaveLength(26);
  });

  it("uses only Crockford base32 alphabet characters", () => {
    const ulid = newUlid();
    for (const ch of ulid) {
      expect(CROCKFORD_ALPHABET).toContain(ch);
    }
  });

  it("encodes the current timestamp into the first 10 characters", () => {
    // Pin the clock at a known millisecond and verify that the timestamp
    // prefix decodes back to it. Decoding is the inverse of encodeTime in
    // the production module: reduce 5-bit chunks back into a 48-bit number.
    const fixed = 1_730_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const ulid = newUlid();
    const prefix = ulid.slice(0, 10);

    let decoded = 0;
    for (const ch of prefix) {
      const idx = CROCKFORD_ALPHABET.indexOf(ch);
      // Multiplication keeps the math 48-bit safe (Number can represent up
      // to 2^53). Using *= 32 + addition matches the encoder's bit layout.
      decoded = decoded * 32 + idx;
    }
    expect(decoded).toBe(fixed);
  });

  it("is lexicographically sortable by creation time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const earlier = newUlid();
    vi.setSystemTime(1_700_000_001_000);
    const later = newUlid();

    expect([later, earlier].slice().sort()).toEqual([earlier, later]);
  });

  it("returns distinct IDs on rapid successive calls", () => {
    const ulids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      ulids.add(newUlid());
    }
    // 80 bits of entropy makes a same-millisecond collision astronomically
    // improbable; the assertion guards against the encoder accidentally
    // reusing entropy across calls.
    expect(ulids.size).toBe(100);
  });
});
