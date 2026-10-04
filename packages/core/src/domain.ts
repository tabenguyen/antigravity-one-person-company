import type { LintFinding, RejectionCategory } from "./quality.ts";

// Core domain types shared by every agy-hq package.
// Persistence lives in @agyhq/db; these are the in-memory shapes.

export type Iso = string; // ISO-8601 timestamp

export type AgentRole = "sales-sdr" | "account-manager" | "chief-of-staff" | "fanpage-manager";

/** Trust tiers are enforced by agy-hq (outbox policy), not by agy flags. See docs/PHASE0.md D4. */
export type TrustTier = "shadow" | "assisted" | "autonomous";

export type AgentStatus = "active" | "paused" | "archived";

export interface Agent {
  id: string; // slug, e.g. "sdr-01"; also the workspace dir name
  role: AgentRole;
  displayName: string;
  model: string; // agy model id, e.g. "gemini-3.8-flash-medium"
  status: AgentStatus;
  trustTier: TrustTier;
  workspacePath: string; // absolute
  managerId: string | null;
  policy: ToolPolicy;
  /** Max concurrent tasks for this agent. */
  maxConcurrency: number;
  createdAt: Iso;
  updatedAt: Iso;
}

// ---------------------------------------------------------------------------
// Tool policy (enforced by the PreToolUse hook via POST /hooks/pre-tool-use)

export interface McpToolRef {
  server: string; // agy ServerName, e.g. "company"
  tool: string; // agy ToolName, e.g. "kb_search"; "*" = any tool on that server
}

export interface ToolPolicy {
  /** agy built-in tool names allowed (e.g. "view_file"). Everything else denied. */
  builtins: string[];
  /** MCP tools allowed via call_mcp_tool. */
  mcp: McpToolRef[];
}

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "allow"; overwrite: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Tasks

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_external"
  | "done"
  | "failed"
  | "cancelled";

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];

/** Allowed state transitions. Anything not listed is a bug. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["done", "failed", "queued", "waiting_approval", "waiting_external", "cancelled"],
  waiting_approval: ["queued", "done", "cancelled", "failed"],
  waiting_external: ["queued", "cancelled", "failed"],
  done: [],
  failed: ["queued"], // manual retry
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export interface Task {
  id: string; // ulid-ish, sortable
  agentId: string;
  kind: string; // e.g. "sdr.research_lead", "sdr.handle_reply"
  title: string;
  input: Record<string, unknown>;
  status: TaskStatus;
  priority: number; // higher runs first; default 0
  /** Tasks sharing a threadKey never run concurrently (e.g. "contact:jane@acme.com"). */
  threadKey: string | null;
  /** agy conversation id to resume, if any. */
  conversationId: string | null;
  parentTaskId: string | null;
  createdByAgentId: string | null; // null = human / system
  attempts: number;
  maxAttempts: number;
  /** Do not run before this time (follow-ups, backoff). */
  wakeAt: Iso | null;
  result: TaskResult | null;
  error: string | null;
  createdAt: Iso;
  updatedAt: Iso;
}

/** Structured result every agent run must return (enforced with agy --json-schema). */
export interface TaskResult {
  status: "done" | "needs_human" | "waiting_external" | "failed";
  summary: string;
  /** Follow-up the agent wants scheduled, e.g. "follow up in 3 days". */
  followUp?: { afterHours: number; note: string } | null;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runs (one agy process invocation for a task)

export type RunOutcome = "ok" | "timeout" | "denied" | "empty" | "invalid_output" | "error";

export interface AgyUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [k: string]: unknown;
}

export interface RunResult {
  outcome: RunOutcome;
  conversationId: string | null;
  text: string; // final response text
  structured: unknown | null; // structured_output when --json-schema used
  usage: AgyUsage | null;
  deniedActions: unknown[];
  exitCode: number | null;
  durationMs: number;
  agyVersion: string | null;
  stderrTail: string; // last ~4KB of stderr
  error: string | null;
}

export interface QuotaBucket {
  group: string; // e.g. "Gemini Models"
  window: string; // e.g. "weekly" | "5h"
  remainingFraction: number; // 0..1
  resetTime: Iso | null;
}

// ---------------------------------------------------------------------------
// Knowledge & memory

export type KbScope = "company" | `role:${AgentRole}` | `agent:${string}`;

export interface KbHit {
  docId: string;
  title: string;
  scope: KbScope;
  snippet: string;
  score: number;
}

export type MemoryStatus = "pending" | "accepted" | "rejected";

export interface MemoryItem {
  id: string;
  agentId: string;
  subject: string | null; // e.g. "contact:jane@acme.com" or null for general
  content: string;
  status: MemoryStatus;
  createdAt: Iso;
}

// ---------------------------------------------------------------------------
// CRM (minimal for Sales SDR)

/** Contact lifecycle stage (the name is kept from the SDR-only days). */
export type LeadStage =
  | "new"
  | "researching"
  | "contacted"
  | "replied"
  | "qualified"
  | "meeting_booked"
  | "disqualified"
  | "nurture"
  | "customer" // won: owned by an account manager
  | "churned"; // customer who explicitly cancelled

export interface Contact {
  id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  companyId: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  language: string | null; // "vi" | "en" | ...
  stage: LeadStage;
  ownerAgentId: string | null;
  source: string | null;
  attributes: Record<string, unknown>;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  country: string | null;
  attributes: Record<string, unknown>;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Note {
  id: string;
  subjectType: "contact" | "company";
  subjectId: string;
  authorAgentId: string | null;
  body: string;
  createdAt: Iso;
}

// ---------------------------------------------------------------------------
// Outbox
//
// Lifecycle (enforced by the daemon, see OUTBOX_TRANSITIONS):
//   pending_approval ─approve→ approved ─sender→ sending → sent | failed
//                    ─approve (agent in shadow tier)→ held   (never sent)
//                    ─reject→ rejected
//   blocked: refused at draft time (opt-out, limits) — terminal.
// Autonomous-tier agents' drafts are auto-approved when outbox policy allows.
// `held` is terminal on purpose: promoting an agent out of shadow must never
// release old practice drafts.

/**
 * `email` is sent by the email Sender; the `facebook_*` channels are sent by the FacebookSender (docs/FANPAGE.md):
 * a post (always as a scheduled post), a public reply to a comment, or hiding a comment. For the Facebook channels
 * `to` is `fb:page:<pageId>` / `fb:comment:<commentId>` / `fb:hide:<commentId>`, `subject` is a short label, `body` is
 * the post / reply text (or the reason for a hide) and `payload` carries the structured parts.
 */
export type OutboxChannel = "email" | "facebook_post" | "facebook_reply" | "facebook_hide";

export const FACEBOOK_OUTBOX_CHANNELS: readonly OutboxChannel[] = ["facebook_post", "facebook_reply", "facebook_hide"];

export function isFacebookChannel(channel: OutboxChannel): boolean {
  return channel !== "email";
}

export type FbPostType = "news" | "feature" | "release" | "tip" | "other";
export const FB_POST_TYPES: readonly FbPostType[] = ["news", "feature", "release", "tip", "other"];

/** Structured parts of a Facebook outbox item (core OutboxItem.payload). `null` for email. */
export type OutboxPayload =
  | {
      kind: "post";
      postType: FbPostType;
      /** Link attached to the post (the `link` field of the Graph API); null = text only. */
      link: string | null;
      /** News posts: the article the post cites. The post body must contain it. */
      sourceUrl: string | null;
      /** When the agent proposes it goes live. The sender never schedules earlier than now + the configured lead time. */
      publishAt: Iso | null;
      /** Set once the post was handed to Facebook: when it will go live, and the Facebook post id. */
      scheduledPublishTime?: Iso | null;
      fbPostId?: string | null;
    }
  | {
      kind: "reply";
      commentId: string;
      postId: string | null;
      /** The comment being answered, so the reviewer sees it without opening Facebook. */
      commentText: string;
      commenterName: string | null;
      fbReplyId?: string | null;
    }
  | {
      kind: "hide";
      commentId: string;
      postId: string | null;
      commentText: string;
      commenterName: string | null;
      /** Why the agent proposes hiding it (spam, abuse, ...). */
      reason: string;
    };
export type OutboxStatus =
  | "pending_approval"
  | "approved"
  | "held"
  | "rejected"
  | "sending"
  | "sent"
  | "failed"
  | "blocked";

export const OUTBOX_TRANSITIONS: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> = {
  pending_approval: ["approved", "held", "rejected", "blocked"],
  approved: ["sending", "rejected", "blocked"], // reject/block still possible until the sender picks it up
  sending: ["sent", "failed", "approved"], // approved = released back after a crash mid-send
  failed: ["approved"], // manual retry
  held: [],
  rejected: [],
  sent: [],
  blocked: [],
};

export interface OutboxItem {
  id: string;
  agentId: string;
  taskId: string | null;
  channel: OutboxChannel;
  to: string;
  subject: string | null;
  body: string;
  reason: string;
  threadKey: string | null;
  status: OutboxStatus;
  /** What the agent drafted; subject/body above may be human-edited. */
  originalSubject: string | null;
  originalBody: string;
  editedByHuman: boolean;
  /** "human:<name>" | "policy:autonomous" | null while pending. */
  decidedBy: string | null;
  decidedAt: Iso | null;
  /** Approval note or rejection reason (rejection reasons become agent memory). */
  decisionNote: string | null;
  /** Why it can't be sent (blocked/failed) — human-readable. */
  statusReason: string | null;
  /** RFC 5322 Message-ID we sent with; In-Reply-To when replying in a thread. */
  messageId: string | null;
  inReplyTo: string | null;
  sentAt: Iso | null;
  attempts: number;
  /** Deterministic draft checks run at draft time (and after human edits). */
  lint: LintFinding[];
  /** Set when rejected by a human. */
  rejectionCategory: RejectionCategory | null;
  /** How many times the agent rewrote this draft in place while it was still pending (same task, same recipient). */
  revisions: number;
  /** Structured parts of a Facebook item (post / comment preview); null for email. */
  payload: OutboxPayload | null;
  createdAt: Iso;
  updatedAt: Iso;
}

/**
 * `decidedBy` of a pending draft the daemon closed because the agent wrote a newer one for the same thread
 * (see `outbox_draft_email`). Not a human verdict: scorecards, shadow-run stats and KPIs leave these out entirely.
 */
export const SUPERSEDED_DECIDED_BY = "policy:superseded";

/** True for a draft that was replaced by a newer one for the same thread (status `rejected`, decided by policy). */
export function isReplacedDraft(item: Pick<OutboxItem, "status" | "decidedBy">): boolean {
  return item.status === "rejected" && item.decidedBy === SUPERSEDED_DECIDED_BY;
}

// ---------------------------------------------------------------------------
// Inbound events (normalized from email, webhooks, ...)

export type InboundSource = "email" | "webhook";

export type InboundClassification =
  | "reply" // reply on a known thread
  | "new_lead" // unknown sender / form submission
  | "unsubscribe"
  | "auto_reply" // OOO / autoresponder
  | "bounce"
  | "spam"
  | "other";

export type InboundStatus = "received" | "routed" | "ignored" | "failed";

export interface InboundEvent {
  id: string;
  source: InboundSource;
  /** Provider-unique id for dedupe (email Message-ID, webhook delivery id). */
  externalId: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddress: string | null;
  subject: string | null;
  /** Plain text with quoted history stripped. */
  bodyText: string;
  /** Email threading headers, when present. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadKey: string | null; // e.g. "contact:jane@acme.com"
  contactId: string | null;
  classification: InboundClassification;
  status: InboundStatus;
  statusReason: string | null;
  routedTaskId: string | null;
  payload: Record<string, unknown>; // source-specific extras (headers subset, form fields)
  receivedAt: Iso;
  createdAt: Iso;
}

/**
 * A message the mailbox owner sent from their OWN mail client (read from the mailbox's Sent folder, opt-in), recorded
 * so agents know what a human already answered. Only kept when it is related to something we know: it continues a
 * thread we have seen, or it is addressed to an existing contact. Never created for unrelated personal mail.
 */
export interface HumanSentMessage {
  id: string;
  /** Message-ID, or "no-message-id:<folder>:<providerId>" — the dedupe key. */
  externalId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** First recipient (To, else Cc) that is not our own address. */
  toAddress: string | null;
  /** All To+Cc addresses, lowercased. */
  recipients: string[];
  subject: string | null;
  /** Plain text with quoted history stripped. */
  bodyText: string;
  threadKey: string | null;
  contactId: string | null;
  folder: string | null;
  /** The message's own Date header (clamped to now). */
  sentAt: Iso;
  createdAt: Iso;
}

// ---------------------------------------------------------------------------
// Audit

export type AuditKind =
  | "task.created"
  | "task.transition"
  | "run.started"
  | "run.finished"
  | "tool.pre"
  | "tool.post"
  | "tool.denied"
  | "hook.context"
  | "hook.stop"
  | "memory.proposed"
  | "outbox.drafted"
  | "outbox.edited"
  | "outbox.approved"
  | "outbox.held"
  | "outbox.rejected"
  | "outbox.sent"
  | "outbox.failed"
  | "inbound.received"
  | "inbound.routed"
  | "inbound.ignored"
  | "contact.opted_out"
  | "settings.changed"
  | "kb.search"
  | "kb.edited"
  | "outbox.lint_blocked"
  | "agent.promoted"
  | "setup.company_saved"
  | "killswitch.forced"
  | "outbound.auto_paused"
  | "routine.ran"
  | "eval.finished"
  | "contact.handoff"
  | "email.human_sent"
  | "outbox.superseded"
  | "outbox.revised"
  | "outbox.draft_refused"
  | "email.test_sent"
  | "briefing.created"
  | "shadow.started"
  | "shadow.ended"
  | "facebook.comment_received"
  | "facebook.post_scheduled"
  | "facebook.replied"
  | "facebook.hidden"
  | "facebook.scheduled_cancelled"
  | "facebook.preview_created";

// ---------------------------------------------------------------------------
// Daemon settings (persisted, editable from agy-ui / CLI)

export interface HqSettings {
  /** Global kill switch: false = nothing is sent, approved items wait. */
  outboundEnabled: boolean;
  outboundDisabledReason: string | null;
  /** No sending inside quiet hours (local time in `timezone`), e.g. 21 → 8. */
  quietHours: { startHour: number; endHour: number; timezone: string } | null;
  /** Max emails sent per hour, across all agents. */
  sendRatePerHour: number;
  /** Auto-trip the kill switch when, over the last `windowSize` sends, bounces/complaints exceed this fraction. */
  autoTrip: { windowSize: number; maxBounceRate: number };
  /** Agent that receives new leads (inbound unknown senders, web forms). */
  defaultSdrAgentId: string | null;
  /** Agent that owns a contact after a handoff ("Won -> Account Manager"), and handles customer messages. */
  defaultAmAgentId: string | null;
  /** Chief of Staff: triages inbound nothing else owns (`cos.triage`). */
  defaultCosAgentId: string | null;
  /** Fanpage Manager: receives new Facebook comments (`fanpage.reply_comment`) and the content calendar. */
  defaultFanpageAgentId: string | null;
  /** Autonomous agents may only auto-send to contacts that already received a human-approved email. */
  autonomousRequiresPriorApproval: boolean;
}

export const DEFAULT_SETTINGS: HqSettings = {
  outboundEnabled: false, // fail closed: a human turns sending on
  outboundDisabledReason: "not yet enabled",
  quietHours: { startHour: 21, endHour: 8, timezone: "Asia/Ho_Chi_Minh" },
  sendRatePerHour: 30,
  autoTrip: { windowSize: 50, maxBounceRate: 0.05 },
  defaultSdrAgentId: null,
  defaultAmAgentId: null,
  defaultCosAgentId: null,
  defaultFanpageAgentId: null,
  autonomousRequiresPriorApproval: true,
};

export interface AuditEvent {
  id: string;
  at: Iso;
  kind: AuditKind;
  agentId: string | null;
  taskId: string | null;
  conversationId: string | null;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Briefings (the Chief of Staff's daily digest for the owner)

export interface Briefing {
  id: string;
  agentId: string;
  /** The `cos.daily_digest` task that produced it. */
  taskId: string;
  periodStart: Iso;
  periodEnd: Iso;
  markdown: string;
  createdAt: Iso;
}

// ---------------------------------------------------------------------------
// Facebook storage (docs/FANPAGE.md). What the poller saw and what we posted; the Page itself stays the source of truth.

/**
 * Where a stored comment is in our pipeline.
 *   new       stored, no task yet (no active Fanpage agent, or waiting for the `comment_poll` routine)
 *   assigned  a `fanpage.reply_comment` task exists for it
 *   own       written by the Page or by us (never answered; breaks reply loops)
 *   skipped   nothing to answer (no text, already hidden on Facebook)
 *   replied   our reply was posted
 *   hidden    we hid it
 */
export type FbCommentStatus = "new" | "assigned" | "own" | "skipped" | "replied" | "hidden";

export interface FbCommentRecord {
  /** Facebook comment id: the dedupe key, one comment is one record is at most one task. */
  id: string;
  postId: string;
  parentId: string | null;
  message: string;
  authorId: string | null;
  authorName: string | null;
  createdTime: Iso;
  status: FbCommentStatus;
  statusReason: string | null;
  taskId: string | null;
  agentId: string | null;
  ingestedAt: Iso;
}

export interface FbPostRecord {
  id: string;
  message: string | null;
  permalinkUrl: string | null;
  createdTime: Iso;
  isPublished: boolean;
  scheduledPublishTime: Iso | null;
  /** "page": seen in the feed; "agent": created by us (outboxId says which draft). */
  source: "page" | "agent";
  outboxId: string | null;
  seenAt: Iso;
}

/** The reply mapping: which Facebook comment our reply (comment id `replyId`) answers, and the outbox item behind it. */
export interface FbReplyRecord {
  commentId: string;
  replyId: string;
  outboxId: string | null;
  createdAt: Iso;
}
