/**
 * Unit tests for the filesystem-backed `TraceSink`. Drives each public
 * method against a real temp directory; cleans up after itself so the test
 * pass leaves no artifacts under the OS temp tree (and never touches the
 * project's actual `.limn/`).
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemTraceSink } from "../../src/trace/file_sink.js";
import type { TraceRecord } from "../../src/trace/trace.js";

function mockRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "trc_unit_001",
    timestamp: "2026-04-28T00:00:00.000Z",
    kind: "ask",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    latencyMs: 12,
    usage: { inputTokens: 5, outputTokens: 7 },
    request: { messages: [{ role: "user", content: "hi" }] },
    response: { content: "hello" },
    attempts: 1,
    redactedFields: [],
    ...overrides,
  };
}

describe("FileSystemTraceSink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "limn-trace-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates the directory on first write if missing", async () => {
    const nested = join(dir, "deep", "nested");
    const sink = new FileSystemTraceSink(nested);
    await sink.write(mockRecord());

    const entries = await readdir(nested);
    expect(entries.filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("writes a JSON file whose name matches the ULID-then-.json shape", async () => {
    const sink = new FileSystemTraceSink(dir);
    await sink.write(mockRecord());

    const entries = await readdir(dir);
    const jsonFiles = entries.filter((n) => n.endsWith(".json"));
    expect(jsonFiles).toHaveLength(1);
    expect(jsonFiles[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.json$/);
  });

  it("never leaves a .tmp file after a successful write (atomic via rename)", async () => {
    const sink = new FileSystemTraceSink(dir);
    await sink.write(mockRecord());
    const entries = await readdir(dir);
    expect(entries.some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("list() returns records in chronological (ULID-sorted) order", async () => {
    const sink = new FileSystemTraceSink(dir);
    await sink.write(mockRecord({ id: "first" }));
    // A small delay forces a different ULID timestamp prefix; without it
    // both writes can land in the same millisecond and rely solely on the
    // entropy segment for sort order, which is non-deterministic.
    await new Promise((r) => setTimeout(r, 5));
    await sink.write(mockRecord({ id: "second" }));
    await new Promise((r) => setTimeout(r, 5));
    await sink.write(mockRecord({ id: "third" }));

    const out = await sink.list();
    expect(out.map((r) => r.id)).toEqual(["first", "second", "third"]);
  });

  it("list() returns [] when the directory does not exist", async () => {
    const sink = new FileSystemTraceSink(join(dir, "never-created"));
    expect(await sink.list()).toEqual([]);
  });

  it("list() skips malformed JSON files with a warning rather than crashing", async () => {
    const sink = new FileSystemTraceSink(dir);
    await sink.write(mockRecord({ id: "good" }));
    await writeFile(join(dir, "ZZZZZZZZZZZZZZZZZZZZZZZZZZ.json"), "not json", "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await sink.list();
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("good");
    expect(warn).toHaveBeenCalled();
  });

  it("read(id) returns the matching record or null", async () => {
    const sink = new FileSystemTraceSink(dir);
    await sink.write(mockRecord({ id: "trc_alpha" }));
    await new Promise((r) => setTimeout(r, 5));
    await sink.write(mockRecord({ id: "trc_beta" }));

    expect(await sink.read("trc_alpha")).not.toBeNull();
    expect((await sink.read("trc_alpha"))?.id).toBe("trc_alpha");
    expect(await sink.read("trc_missing")).toBeNull();
  });

  it("write() preserves the full TraceRecord shape on disk", async () => {
    const sink = new FileSystemTraceSink(dir);
    const record = mockRecord({
      attempts: 3,
      redactedFields: ["messages.0.content"],
      error: { code: "RATE_LIMIT", message: "slow down" },
    });
    await sink.write(record);

    const out = await sink.list();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(record);
  });
});
