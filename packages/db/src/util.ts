import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** JSON-encode a value for storage in a TEXT column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Decode a TEXT column back into its JSON value, with a fallback for NULL/empty. */
export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  return JSON.parse(raw) as T;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Constant-time comparison of two hex-encoded digests (or any equal-length strings). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) {
    // Still do a comparison of equal-length buffers to avoid leaking length via timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Generate a URL-safe random token for plaintext credentials (agent tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Turn a free-text user query into a safe FTS5 MATCH expression.
 *
 * Every term is wrapped in double quotes (with embedded quotes escaped by
 * doubling), so FTS5 special characters/operators in user input (`OR`, `NOT`,
 * `*`, `(`, `^`, `:`, `-`, a stray `"`, ...) are treated as literal text,
 * never as query syntax — a malformed or hostile query can't throw or change
 * the search's meaning.
 *
 * Terms are OR-joined rather than AND-joined: this is a small, short-query
 * knowledge base (product docs, playbooks), and an AND of every term returns
 * nothing the moment one word isn't in the matching chunk verbatim (easy with
 * Vietnamese compounds and synonyms). OR keeps recall high while bm25 still
 * ranks chunks that match more terms above chunks that match only one, so
 * precision comes from ranking rather than from excluding candidates.
 */
export function sanitizeFtsQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
