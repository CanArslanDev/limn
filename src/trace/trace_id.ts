/**
 * Trace-ID + ULID helpers. Two distinct concerns share this file:
 *
 *  - {@link newTraceId} mints the `trc_<uuid>` identifier surfaced to users
 *    (returned in error messages, embedded in `TraceRecord.id`). The shape
 *    is stable across batches; consumers in `src/client/`, `src/hooks/`, and
 *    the inspector all treat it as an opaque string.
 *  - {@link newUlid} mints a 26-character Crockford-base32 ULID. Used by the
 *    filesystem trace sink as the on-disk file name so directory listings
 *    sort chronologically without an external index.
 *
 * Why two functions: file names and trace IDs serve different audiences.
 * Trace IDs are user-facing (debug surfaces, error messages); ULIDs are
 * infrastructure-facing (file-system ordering). Coupling them would force a
 * format change on either audience to satisfy the other. The on-disk
 * mapping ULID -> trace ID lives in the file's JSON body.
 *
 * Why a hand-rolled ULID encoder: the only runtime dependency Traceworks allows
 * outside provider SDKs is `zod` (CLAUDE.md hard rule #10). A 30-line
 * encoder using `crypto.getRandomValues` for entropy keeps the bundle
 * surface unchanged. The implementation matches the reference ULID spec
 * (https://github.com/ulid/spec): 48-bit big-endian millisecond timestamp
 * (10 chars) + 80-bit randomness (16 chars), Crockford base32.
 *
 * Lives in `src/trace/` per the shared-helper-first principle (CLAUDE.md
 * §13.8). The `src/hooks/` re-export at `dispatcher.ts` is a thin
 * pass-through so existing import sites stay stable.
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Mint a fresh trace ID. Format `trc_<uuid>`; the UUID part is supplied by
 * `crypto.randomUUID` (Node 20.10+ has it on the global). Stable shape since
 * batch 1.1; the inspector and any external tooling can pattern-match on
 * the `trc_` prefix.
 */
export function newTraceId(): string {
  return `trc_${crypto.randomUUID()}`;
}

/**
 * Mint a fresh ULID. 26 characters, Crockford base32, lexicographically
 * sortable by creation time. The first 10 characters encode the
 * millisecond timestamp; the remaining 16 characters encode 80 bits of
 * entropy from `crypto.getRandomValues`.
 */
export function newUlid(): string {
  return `${encodeTime(Date.now())}${encodeRandom()}`;
}

/**
 * Encode a millisecond timestamp into the 10-character Crockford-base32
 * prefix that sorts naturally. Bit twiddling proceeds from the high end so
 * the output reads MSB-first. The 48-bit ceiling matches the ULID spec;
 * `Date.now()` will not exceed it before the year 10889.
 */
function encodeTime(ms: number): string {
  const out = new Array<string>(10);
  // We pull 5 bits at a time from the most significant end, but JavaScript
  // bitwise ops only safely cover 32 bits. Split into a high (16-bit) and
  // low (32-bit) half and shift the high half manually before each step.
  let high = Math.floor(ms / 0x1_0000_0000);
  let low = ms >>> 0;
  for (let i = 9; i >= 0; i -= 1) {
    // Pull the low 5 bits from the combined 48-bit number, then shift the
    // pair right by 5. Because we cannot >>> a 48-bit value directly, the
    // shift is decomposed: low takes the bottom of high after high shifts.
    const idx = low & 0b11111;
    low = (low >>> 5) | ((high & 0b11111) << 27);
    high = high >>> 5;
    out[i] = CROCKFORD_BASE32.charAt(idx);
  }
  return out.join("");
}

/**
 * Encode 80 bits of cryptographic randomness as 16 Crockford-base32
 * characters. We over-pull two bytes (10 bytes = 80 bits exactly, but we
 * read in 5-bit nibbles from a bit cursor) and walk the bit stream so each
 * output character consumes exactly 5 random bits with no skew.
 */
function encodeRandom(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const out = new Array<string>(16);
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIdx = 0;
  for (let i = 0; i < 16; i += 1) {
    while (bitCount < 5) {
      // biome-ignore lint/style/noNonNullAssertion: bounded loop, byteIdx < 10
      bitBuffer = (bitBuffer << 8) | bytes[byteIdx]!;
      byteIdx += 1;
      bitCount += 8;
    }
    const shift = bitCount - 5;
    const idx = (bitBuffer >> shift) & 0b11111;
    bitBuffer &= (1 << shift) - 1;
    bitCount -= 5;
    out[i] = CROCKFORD_BASE32.charAt(idx);
  }
  return out.join("");
}
