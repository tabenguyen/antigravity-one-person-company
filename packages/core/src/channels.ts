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

// ---------------------------------------------------------------------------
// Facebook Page channel contract (docs/FANPAGE.md). Implemented by @agyhq/channels (Graph API / in-memory fake),
// consumed by the daemon. Like the email providers, these only move data: what to say, whether it may go out and
// when live in the daemon. v1 polls for comments; there is no webhook receiver.

/** Permissions the Fanpage Manager needs on its token (docs/FANPAGE-RESEARCH.md section 1). */
export const FB_REQUIRED_PERMISSIONS = [
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_manage_engagement",
  "pages_read_user_content",
  "pages_show_list",
] as const;

/** A Facebook user or Page: who wrote a comment. */
export interface FbAuthor {
  id: string;
  name: string | null;
}

/** A Page post as the provider reports it. */
export interface FbPost {
  id: string;
  pageId: string;
  message: string | null;
  permalinkUrl: string | null;
  createdTime: string; // ISO
  /** false for scheduled and unpublished posts. */
  isPublished: boolean;
  /** When a scheduled post goes live (ISO); null for published and unpublished-preview posts. */
  scheduledPublishTime: string | null;
}

/** A comment on a post, or a reply to another comment. */
export interface FbComment {
  id: string;
  postId: string;
  /** The comment this one replies to; null for a top-level comment. */
  parentId: string | null;
  message: string;
  createdTime: string; // ISO
  /**
   * Who wrote it. Optional on purpose: Facebook may strip `from` for people with no role on the app (open question 1
   * in docs/FANPAGE-RESEARCH.md section 4), so nothing may depend on it being there. Own-comment detection therefore
   * also uses the reply mapping (ids of the replies we posted).
   */
  from?: FbAuthor | null;
  permalinkUrl?: string | null;
  isHidden?: boolean;
}

export interface FbFetchResult {
  /** Recent posts of the Page (published, newest first), for context and the scheduled view. */
  posts: FbPost[];
  /** Comments created at or after the cursor, oldest first. Repeats are possible; the daemon dedupes by comment id. */
  comments: FbComment[];
  /** Opaque cursor for the next fetch (the daemon persists it). */
  cursor: string | null;
}

export type FbPublishMode = "immediate" | "scheduled" | "preview";

export interface OutgoingFbPost {
  message: string;
  link?: string | null;
  /**
   * immediate: published now. scheduled: `published=false` + `scheduledPublishTime` (10 minutes to 75 days ahead).
   * preview: an unpublished post with no schedule, visible to Page admins only.
   */
  mode: FbPublishMode;
  /** ISO; required when mode is "scheduled". */
  scheduledPublishTime?: string | null;
}

export interface OutgoingFbReply {
  commentId: string;
  message: string;
}

export interface FbPostResult {
  postId: string;
  mode: FbPublishMode;
  /** ISO; set for scheduled posts. */
  scheduledPublishTime: string | null;
}

export interface FbReplyResult {
  /** Id of the comment our reply created. The daemon stores it so the poller never answers its own reply. */
  replyId: string;
}

export interface FbPageIdentity {
  id: string;
  name: string | null;
}

/** What `hq facebook doctor` reads from the token. Every field may be unknown; the doctor reports that, not a guess. */
export interface FbInspection {
  tokenValid: boolean;
  /** Why the token is not valid, when it is not. */
  tokenError: string | null;
  /** The Page the token resolves to (`/me`). */
  page: FbPageIdentity | null;
  /** Permissions granted to the token; null when this token type does not list them. */
  granted: string[] | null;
  declined: string[];
  appMode: "development" | "live" | "unknown";
  /** Whether every Graph call carries `appsecret_proof` (true only when an app secret is configured). */
  appSecretProof: boolean;
  /** Free-form remarks (e.g. "token belongs to a system user"). */
  notes: string[];
}

export interface FacebookPageProvider {
  readonly kind: string; // "graph" | "fake"
  readonly pageId: string;
  /**
   * Recent posts of the Page and the comments created since `cursor`. A null cursor means "from now": no comments are
   * returned and the cursor is set to the present, so connecting a Page never replays its history.
   */
  fetchNew(cursor: string | null, opts?: { limit?: number; lookbackDays?: number }): Promise<FbFetchResult>;
  createPost(post: OutgoingFbPost): Promise<FbPostResult>;
  /** Posts that are scheduled and not yet live. */
  listScheduledPosts(): Promise<FbPost[]>;
  /** Cancel (delete) a scheduled post. */
  cancelScheduledPost(postId: string): Promise<void>;
  replyToComment(reply: OutgoingFbReply): Promise<FbReplyResult>;
  hideComment(commentId: string): Promise<void>;
  /** Token, Page identity, granted permissions and app mode, for `hq facebook doctor`. Never throws for a bad token. */
  inspect(): Promise<FbInspection>;
  /** Cheap connectivity check for health/status UI. */
  verify(): Promise<{ ok: true; page: FbPageIdentity } | { ok: false; error: string }>;
  close(): Promise<void>;
}
