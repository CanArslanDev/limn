/**
 * Filesystem-backed `TraceSink`. Writes one JSON file per record into the
 * configured directory, named by ULID so directory listings sort
 * chronologically without an external index. The trace ID inside the
 * record is preserved separately (the file name is for ordering; the ID is
 * for lookup), so renaming a file or copying it between directories never
 * breaks the inspector's cross-references.
 *
 * Atomicity: each write lands at `<ulid>.json.tmp` first, then `rename`s
 * into place. The inspector (Phase 2) and any third-party tail-the-dir
 * tooling can rely on `<ulid>.json` files always being complete JSON. The
 * `.tmp` suffix is excluded from `list()`.
 *
 * Lazy mkdir: the directory is created on first `write()`. Tests that
 * exercise `list()` against a never-written directory get an empty array
 * back, matching the user-friendly "no traces yet" experience.
 *
 * Error tolerance on `list()`: a malformed JSON file (corrupted, partially
 * written by an external tool, hand-edited) is skipped with a `console.warn`
 * rather than crashing the whole listing. Hooks already follow this
 * "observability degrades but the call survives" philosophy; the sink
 * extends it to the read path so the inspector never blows up on a single
 * bad file.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TraceRecord, TraceSink } from "./trace.js";
import { newUlid } from "./trace_id.js";

export class FileSystemTraceSink implements TraceSink {
  public constructor(private readonly dir: string) {}

  /**
   * Persist a record to disk. The file name is a fresh ULID so concurrent
   * writes do not collide and the natural sort matches creation order. The
   * write is atomic via temp-file + rename so partial reads are impossible.
   */
  public async write(record: TraceRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const fileName = `${newUlid()}.json`;
    const finalPath = join(this.dir, fileName);
    const tmpPath = `${finalPath}.tmp`;
    const body = JSON.stringify(record, null, 2);
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, finalPath);
  }

  /**
   * Return all records in the directory in chronological (ULID-sorted)
   * order. Missing directory yields `[]`. Malformed files are skipped with a
   * warning. The result is materialized eagerly because Phase 1 trace
   * directories are small (<1000 records); Phase 2 will introduce
   * pagination if browsing large dirs gets slow.
   */
  public async list(): Promise<readonly TraceRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      // ENOENT is the "user has not run anything yet" path; surface it as
      // an empty list. Other errors (EACCES, EIO) re-throw so they reach
      // the developer rather than silently hiding behind an empty array.
      if (isNotFoundError(err)) return [];
      throw err;
    }

    const jsonFiles = entries.filter((name) => name.endsWith(".json")).sort();
    const out: TraceRecord[] = [];
    for (const name of jsonFiles) {
      const path = join(this.dir, name);
      try {
        const raw = await readFile(path, "utf8");
        out.push(JSON.parse(raw) as TraceRecord);
      } catch (err) {
        console.warn(`[limn] failed to read trace file ${path}:`, err);
      }
    }
    return out;
  }

  /**
   * Look up a record by its trace ID. The file name is a ULID, not the
   * trace ID, so this scans `list()` and matches on the JSON body's `id`
   * field. Phase 2 will index hot lookup paths; Phase 1 keeps the
   * implementation minimal.
   */
  public async read(id: string): Promise<TraceRecord | null> {
    const records = await this.list();
    return records.find((r) => r.id === id) ?? null;
  }
}

/**
 * Narrow an unknown thrown value to "directory does not exist". `fs.promises`
 * methods reject with `NodeJS.ErrnoException`, but TypeScript types it as
 * `unknown`; we sniff `code === "ENOENT"` defensively.
 */
function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}
