/**
 * API-key redaction for the trace pipeline. Walks an arbitrary JSON-shaped
 * payload (object, array, primitive) and replaces known key patterns with
 * `[REDACTED]`. Returns both the cleaned payload and the dot-paths of
 * fields that contained a redacted substring, so the trace record can
 * surface "what was redacted" without leaking the secret itself.
 *
 * Patterns recognized (longest prefix wins so `sk-ant-` is never partially
 * matched as `sk-`):
 *
 *  - `sk-ant-<suffix>`   Anthropic API keys
 *  - `sk-proj-<suffix>`  OpenAI project-scoped keys
 *  - `sk-<suffix>`       OpenAI legacy / generic
 *
 * Length heuristic: only redact when the suffix is at least 16 characters of
 * `[A-Za-z0-9_-]`. Avoids clobbering strings that legitimately start with
 * `sk-` but are not credentials (Slack channel names, sketch identifiers).
 *
 * Path semantics: object keys join with `.`, array indices appear as
 * numeric segments. A redaction inside `{ messages: [{ content: "sk-..." }] }`
 * surfaces the path `messages.0.content`. A top-level string redaction
 * surfaces the empty path `""`.
 *
 * The redactor is total over JSON-serializable inputs. Cycles are not
 * possible in our pipeline (the records head straight to `JSON.stringify`
 * which would also reject them), so the walker has no cycle guard.
 */

const REDACTED = "[REDACTED]";

// Order matters: longest prefix first. Each pattern requires at least 16
// trailing url-safe characters so short prose like `sk-x` slips through
// untouched. The capture group is the entire matched key (prefix + suffix)
// which gets replaced wholesale with [REDACTED].
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
];

export interface RedactResult {
  /** Deep-cloned payload with key substrings replaced by `[REDACTED]`. */
  readonly value: unknown;
  /** Dot-paths of every field that contained at least one redaction. */
  readonly redacted: readonly string[];
}

/**
 * Walk `value`, replacing API-key substrings inside any string field. The
 * input is not mutated; objects and arrays are recreated. Non-JSON-shaped
 * leaves (numbers, booleans, null, undefined) pass through unchanged.
 *
 * Functions, symbols, BigInts, and other non-serializable values are
 * preserved by reference (they would not survive `JSON.stringify` anyway,
 * so the redactor's job is done once string content is clean).
 */
export function redactKeys(value: unknown): RedactResult {
  const redacted: string[] = [];
  const cleaned = walk(value, "", redacted);
  return { value: cleaned, redacted };
}

function walk(node: unknown, path: string, sink: string[]): unknown {
  if (typeof node === "string") {
    return redactString(node, path, sink);
  }
  if (Array.isArray(node)) {
    return node.map((item, idx) => walk(item, joinPath(path, String(idx)), sink));
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node)) {
      out[key] = walk(val, joinPath(path, key), sink);
    }
    return out;
  }
  return node;
}

function redactString(input: string, path: string, sink: string[]): string {
  let result = input;
  let matched = false;
  for (const pattern of KEY_PATTERNS) {
    // Each pattern is anchored with the global flag so .replace replaces
    // every occurrence within the string. Reset lastIndex defensively in
    // case a prior throw left it nonzero (regex objects are module-shared).
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      matched = true;
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
    }
  }
  if (matched) {
    sink.push(path);
  }
  return result;
}

function joinPath(parent: string, child: string): string {
  return parent === "" ? child : `${parent}.${child}`;
}
