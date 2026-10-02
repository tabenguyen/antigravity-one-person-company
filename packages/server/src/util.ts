import { randomBytes } from "node:crypto";

/** URL-safe random token (admin token, run tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** Agent id / slug validation: lowercase alnum + internal hyphens, 1-64 chars. */
export function isValidSlug(id: string): boolean {
  return SLUG_RE.test(id);
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
