// Email channel contract. Implemented by @agyhq/channels, consumed by the daemon.
// Providers only move messages; classification, routing and policy live in the daemon.

export interface EmailAddress {
  address: string; // lowercased
  name: string | null;
}

/** A received message, already parsed. */
export interface ParsedEmail {
  /** Provider cursor value for this message (IMAP UID, maildir filename, ...). */
  providerId: string;
  messageId: string | null; // without angle brackets
  inReplyTo: string | null; // without angle brackets
  references: string[]; // without angle brackets
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress | null;
  subject: string | null;
  date: string | null; // ISO
  /** Full plain-text body (HTML converted to text if no text part). */
  text: string;
  /** Body with quoted reply history and signatures-separators stripped (best effort). */
  replyText: string;
  /** Lowercased header names → values, limited to the ones classification needs. */
  headers: Record<string, string>;
  /** `content` is the decoded file body; the daemon writes it to disk and never persists it in the DB. */
  attachments: { filename: string | null; contentType: string; size: number; content?: Uint8Array }[];
}

export interface FetchResult {
  messages: ParsedEmail[];
  /** Opaque cursor to pass to the next fetch (persisted by the daemon). */
  cursor: string | null;
}

export interface OutgoingEmail {
  from: EmailAddress;
  to: EmailAddress;
  subject: string;
  text: string;
  /** Our own Message-ID (without brackets); provider must send exactly this. */
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** e.g. "<mailto:unsubscribe@acme.com?subject=unsubscribe>" — sets List-Unsubscribe. */
  listUnsubscribe?: string | null;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
  /** Provider response summary for audit (e.g. SMTP "250 OK"). */
  response: string;
  accepted: string[];
  rejected: string[];
}

export interface EmailProvider {
  readonly kind: string; // "imap-smtp" | "maildir" | "fake"
  /** Fetch messages newer than `cursor` (null = provider decides a safe start, e.g. only new from now). */
  fetchNew(cursor: string | null, opts?: { limit?: number }): Promise<FetchResult>;
  send(email: OutgoingEmail): Promise<SendResult>;
  /**
   * Optional, opt-in: messages the mailbox owner sent from their OWN mail client (the mailbox's Sent folder), so the
   * harness learns what humans already answered. Same cursor contract as fetchNew, but over a separate cursor.
   * Absent / `syncsSent === false` = the provider does not (or is not configured to) read a Sent folder.
   * Rejects when the Sent folder cannot be found (the message says why); callers treat that as non-fatal.
   */
  fetchSent?(cursor: string | null, opts?: { limit?: number }): Promise<FetchResult & { folder: string }>;
  /** True when `fetchSent` is available and enabled for this provider instance. */
  readonly syncsSent?: boolean;
  /** Cheap connectivity check for health/status UI. */
  verify(): Promise<{ ok: true } | { ok: false; error: string }>;
  close(): Promise<void>;
}

/** Heuristic classification of a parsed email (pure, provider-independent). */
export interface EmailSignals {
  isAutoReply: boolean; // Auto-Submitted, X-Autoreply, OOO subjects (en/vi)
  isBounce: boolean; // DSN / mailer-daemon
  bouncedRecipient: string | null;
  isUnsubscribe: boolean; // "unsubscribe" / "hủy đăng ký" / "stop" etc. in a short reply
  isLikelySpam: boolean;
}
