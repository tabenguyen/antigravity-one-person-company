// RFC 5322 Message-ID helpers. Everywhere in this package (and in @agyhq/core's
// ParsedEmail/OutgoingEmail contract) a "message id" is stored WITHOUT the
// surrounding angle brackets; providers add/strip them at the wire boundary.

import { newId } from "@agyhq/core";

/** A fresh, time-sortable Message-ID value for `domain`, e.g. "01hx...@acme.com". No angle brackets. */
export function newMessageId(domain: string): string {
  return `${newId().toLowerCase()}@${domain}`;
}

/**
 * Strip angle brackets and surrounding whitespace from a Message-ID/In-Reply-To
 * value. Returns null for null/undefined/empty input. Case is left untouched
 * (Message-IDs are case-sensitive tokens).
 */
export function normalizeMessageId(id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^<+/, "").replace(/>+$/, "").trim();
  return stripped || null;
}
