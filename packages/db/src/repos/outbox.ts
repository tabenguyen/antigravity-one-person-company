import type Database from "better-sqlite3";
import { OUTBOX_TRANSITIONS, SUPERSEDED_DECIDED_BY } from "@agyhq/core";
import type { Iso, LintFinding, OutboxChannel, OutboxItem, OutboxPayload, OutboxStatus, RejectionCategory } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { ConflictError, NotFoundError, OutboxTransitionError } from "../errors.ts";

type SqliteDb = Database.Database;

interface OutboxRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  channel: string;
  to: string;
  subject: string | null;
  body: string;
  reason: string;
  thread_key: string | null;
  status: string;
  original_subject: string | null;
  original_body: string;
  edited_by_human: number;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  status_reason: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  sent_at: string | null;
  attempts: number;
  lint: string;
  rejection_category: string | null;
  revisions: number;
  payload: string | null;
  created_at: string;
  updated_at: string;
}

function parsePayload(raw: string | null | undefined): OutboxPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as OutboxPayload) : null;
  } catch {
    return null;
  }
}

function parseLint(raw: string | null | undefined): LintFinding[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? (v as LintFinding[]) : [];
  } catch {
    return [];
  }
}

function mapRow(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id,
    channel: row.channel as OutboxChannel,
    to: row.to,
    subject: row.subject,
    body: row.body,
    reason: row.reason,
    threadKey: row.thread_key,
    status: row.status as OutboxStatus,
    originalSubject: row.original_subject,
    originalBody: row.original_body,
    editedByHuman: Boolean(row.edited_by_human),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    statusReason: row.status_reason,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    sentAt: row.sent_at,
    attempts: row.attempts,
    lint: parseLint(row.lint),
    rejectionCategory: (row.rejection_category as RejectionCategory | null) ?? null,
    revisions: row.revisions ?? 0,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateDraftInput {
  agentId: string;
  taskId?: string | null;
  channel: OutboxChannel;
  to: string;
  subject?: string | null;
  body: string;
  reason: string;
  threadKey?: string | null;
  lint?: LintFinding[];
  /** Facebook items: structured parts (post / comment preview). */
  payload?: OutboxPayload | null;
}

export interface ReviseDraftInput {
  subject: string | null;
  body: string;
  reason: string;
  threadKey: string | null;
  lint: LintFinding[];
  /** Facebook items: replaces the payload (the new draft's structured parts). */
  payload?: OutboxPayload | null;
}

export interface ListOutboxFilter {
  agentId?: string;
  status?: OutboxStatus[];
  limit?: number;
}

export interface DecidePatch {
  decidedBy?: string | null;
  decidedAt?: Iso | null;
  decisionNote?: string | null;
  statusReason?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  sentAt?: Iso | null;
  rejectionCategory?: RejectionCategory | null;
}

export interface EditPatch {
  subject?: string;
  body?: string;
}

export class OutboxRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  createDraft(input: CreateDraftInput): OutboxItem {
    const now = nowIso();
    const item: OutboxItem = {
      id: newId("obx"),
      agentId: input.agentId,
      taskId: input.taskId ?? null,
      channel: input.channel,
      to: input.to,
      subject: input.subject ?? null,
      body: input.body,
      reason: input.reason,
      threadKey: input.threadKey ?? null,
      status: "pending_approval",
      originalSubject: input.subject ?? null,
      originalBody: input.body,
      editedByHuman: false,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      statusReason: null,
      messageId: null,
      inReplyTo: null,
      sentAt: null,
      attempts: 0,
      lint: input.lint ?? [],
      rejectionCategory: null,
      revisions: 0,
      payload: input.payload ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO outbox
           (id, agent_id, task_id, channel, "to", subject, body, reason, thread_key, status,
            original_subject, original_body, edited_by_human, decided_by, decided_at, decision_note,
            status_reason, message_id, in_reply_to, sent_at, attempts, lint, payload, created_at, updated_at)
         VALUES
           (@id, @agentId, @taskId, @channel, @to, @subject, @body, @reason, @threadKey, @status,
            @originalSubject, @originalBody, @editedByHuman, @decidedBy, @decidedAt, @decisionNote,
            @statusReason, @messageId, @inReplyTo, @sentAt, @attempts, @lint, @payload, @createdAt, @updatedAt)`,
      )
      .run({ ...item, editedByHuman: 0, lint: JSON.stringify(item.lint), rejectionCategory: undefined, revisions: undefined, payload: item.payload ? JSON.stringify(item.payload) : null });
    return item;
  }

  get(id: string): OutboxItem | null {
    const row = this.#db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(filter: ListOutboxFilter = {}): OutboxItem[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.agentId) {
      clauses.push("agent_id = @agentId");
      params.agentId = filter.agentId;
    }
    if (filter.status && filter.status.length) {
      const names = filter.status.map((_, i) => `@status${i}`);
      filter.status.forEach((s, i) => {
        params[`status${i}`] = s;
      });
      clauses.push(`status IN (${names.join(", ")})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ? "LIMIT @limit" : "";
    if (filter.limit) params.limit = filter.limit;
    const rows = this.#db
      .prepare(`SELECT * FROM outbox ${where} ORDER BY created_at DESC, rowid DESC ${limit}`)
      .all(params) as OutboxRow[];
    return rows.map(mapRow);
  }

  listByThreadKey(threadKey: string, limit = 20): OutboxItem[] {
    const rows = this.#db
      .prepare(`SELECT * FROM outbox WHERE thread_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(threadKey, limit) as OutboxRow[];
    return rows.map(mapRow);
  }

  findByMessageId(messageId: string): OutboxItem | null {
    const row = this.#db.prepare("SELECT * FROM outbox WHERE message_id = ?").get(messageId) as OutboxRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Items addressed to `to` (case-insensitive) in any of `statuses` (default: all), newest first. */
  listByRecipient(to: string, statuses?: OutboxStatus[]): OutboxItem[] {
    const marks = statuses && statuses.length ? ` AND status IN (${statuses.map(() => "?").join(", ")})` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM outbox WHERE lower("to") = lower(?)${marks} ORDER BY created_at DESC, rowid DESC`)
      .all(to, ...(statuses ?? [])) as OutboxRow[];
    return rows.map(mapRow);
  }

  /** Drafts one task wrote to one recipient (case-insensitive), newest first. */
  listByTaskAndRecipient(taskId: string, to: string): OutboxItem[] {
    const rows = this.#db
      .prepare(`SELECT * FROM outbox WHERE task_id = ? AND lower("to") = lower(?) ORDER BY created_at DESC, rowid DESC`)
      .all(taskId, to) as OutboxRow[];
    return rows.map(mapRow);
  }

  /**
   * Rewrite a still-pending draft in place (the agent redrafted the same email): same id, so the reviewer keeps one
   * queue item. What the agent wrote is the new baseline for the edit ratio (`original_*` follow the new text), and
   * `revisions` counts the rewrites. Refuses once a human has edited it or it left `pending_approval`.
   */
  revise(id: string, input: ReviseDraftInput): OutboxItem {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("outbox item", id);
    if (existing.status !== "pending_approval") {
      throw new ConflictError(`outbox item ${id} can only be revised while pending_approval (current status: ${existing.status})`);
    }
    if (existing.editedByHuman) {
      throw new ConflictError(`outbox item ${id} was edited by a human and can no longer be rewritten by the agent`);
    }
    const updatedAt = nowIso();
    const revisions = existing.revisions + 1;
    const payload = input.payload === undefined ? existing.payload : input.payload;
    this.#db
      .prepare(
        `UPDATE outbox SET subject = @subject, body = @body, original_subject = @subject, original_body = @body,
           reason = @reason, thread_key = @threadKey, lint = @lint, revisions = @revisions, payload = @payload, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({ id, subject: input.subject, body: input.body, reason: input.reason, threadKey: input.threadKey, lint: JSON.stringify(input.lint), revisions, payload: payload ? JSON.stringify(payload) : null, updatedAt });
    return {
      ...existing,
      subject: input.subject,
      body: input.body,
      originalSubject: input.subject,
      originalBody: input.body,
      reason: input.reason,
      threadKey: input.threadKey,
      lint: input.lint,
      revisions,
      payload,
      updatedAt,
    };
  }

  /** Replace the structured parts of a Facebook item (a human changing the planned time, the sender recording the post id). */
  setPayload(id: string, payload: OutboxPayload): OutboxItem {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("outbox item", id);
    const updatedAt = nowIso();
    this.#db.prepare("UPDATE outbox SET payload = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(payload), updatedAt, id);
    return { ...existing, payload, updatedAt };
  }

  /**
   * Close a pending draft because a newer one for the same thread replaced it: pending_approval -> rejected, decided by
   * `policy:superseded` (never a human verdict, so scorecards ignore it), with a `superseded: ...` reason the Inbox shows.
   */
  supersede(id: string, reason: string): OutboxItem {
    return this.decide(id, "rejected", { decidedBy: SUPERSEDED_DECIDED_BY, decidedAt: nowIso(), statusReason: reason });
  }

  /** Has this address ever received a `sent` email that a human (not policy) approved? */
  hasHumanApprovedSentTo(address: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 FROM outbox WHERE lower("to") = lower(?) AND status = 'sent' AND decided_by LIKE 'human:%' LIMIT 1`,
      )
      .get(address);
    return row !== undefined;
  }

  /** @deprecated kept for backward-compat call sites; prefer `decide`. */
  setStatus(id: string, status: OutboxStatus): OutboxItem {
    return this.decide(id, status, {});
  }

  /** Replace a draft's lint findings (after a human edit or a re-check). */
  setLint(id: string, lint: LintFinding[]): OutboxItem {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("outbox item", id);
    const updatedAt = nowIso();
    this.#db.prepare("UPDATE outbox SET lint = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(lint), updatedAt, id);
    return { ...existing, lint, updatedAt };
  }

  /** Human edit of subject/body — only while pending_approval. */
  edit(id: string, patch: EditPatch): OutboxItem {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("outbox item", id);
    if (existing.status !== "pending_approval") {
      throw new ConflictError(
        `outbox item ${id} can only be edited while pending_approval (current status: ${existing.status})`,
      );
    }
    const updatedAt = nowIso();
    const subject = patch.subject !== undefined ? patch.subject : existing.subject;
    const body = patch.body !== undefined ? patch.body : existing.body;
    this.#db
      .prepare(`UPDATE outbox SET subject = ?, body = ?, edited_by_human = 1, updated_at = ? WHERE id = ?`)
      .run(subject, body, updatedAt, id);
    return { ...existing, subject, body, editedByHuman: true, updatedAt };
  }

  /** Validated status transition (OUTBOX_TRANSITIONS) with optional decision/send metadata. */
  decide(id: string, to: OutboxStatus, patch: DecidePatch = {}): OutboxItem {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("outbox item", id);
    if (!OUTBOX_TRANSITIONS[existing.status].includes(to)) {
      throw new OutboxTransitionError(id, existing.status, to);
    }
    const updatedAt = nowIso();
    const updated: OutboxItem = {
      ...existing,
      status: to,
      decidedBy: patch.decidedBy !== undefined ? patch.decidedBy : existing.decidedBy,
      decidedAt: patch.decidedAt !== undefined ? patch.decidedAt : existing.decidedAt,
      decisionNote: patch.decisionNote !== undefined ? patch.decisionNote : existing.decisionNote,
      statusReason: patch.statusReason !== undefined ? patch.statusReason : existing.statusReason,
      messageId: patch.messageId !== undefined ? patch.messageId : existing.messageId,
      inReplyTo: patch.inReplyTo !== undefined ? patch.inReplyTo : existing.inReplyTo,
      sentAt: patch.sentAt !== undefined ? patch.sentAt : existing.sentAt,
      rejectionCategory: patch.rejectionCategory !== undefined ? patch.rejectionCategory : existing.rejectionCategory,
      updatedAt,
    };
    this.#db
      .prepare(
        `UPDATE outbox SET status = @status, decided_by = @decidedBy, decided_at = @decidedAt,
           decision_note = @decisionNote, status_reason = @statusReason, message_id = @messageId,
           in_reply_to = @inReplyTo, sent_at = @sentAt, rejection_category = @rejectionCategory,
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({ ...updated, editedByHuman: undefined, lint: undefined, payload: undefined });
    return updated;
  }

  /** Record an attempt count bump alongside a decide() call (transient-failure retry / terminal failure). */
  #bumpAttempts(id: string): number {
    this.#db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(id);
    return (this.#db.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id) as { attempts: number }).attempts;
  }

  /** Transient send failure: sending -> approved (will be retried), attempts += 1. */
  markTransientFailure(id: string, statusReason: string): OutboxItem {
    const updated = this.decide(id, "approved", { statusReason });
    const attempts = this.#bumpAttempts(id);
    return { ...updated, attempts };
  }

  /** Terminal send failure: sending -> failed, attempts += 1. */
  markTerminalFailure(id: string, statusReason: string): OutboxItem {
    const updated = this.decide(id, "failed", { statusReason });
    const attempts = this.#bumpAttempts(id);
    return { ...updated, attempts };
  }

  /** Record a bounce DSN against an already-`sent` item without changing its (terminal) status. */
  annotateBounce(id: string, reason: string): OutboxItem {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("outbox item", id);
    const updatedAt = nowIso();
    const statusReason = `bounced: ${reason}`;
    this.#db.prepare("UPDATE outbox SET status_reason = ?, updated_at = ? WHERE id = ?").run(statusReason, updatedAt, id);
    return { ...existing, statusReason, updatedAt };
  }

  /**
   * Mark a not-yet-sent item as superseded (a human already answered from their own mail client) without changing
   * its status: the reason is shown next to the draft and the Sender refuses an approved item that carries it.
   */
  annotateSuperseded(id: string, reason: string): OutboxItem {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("outbox item", id);
    const updatedAt = nowIso();
    this.#db.prepare("UPDATE outbox SET status_reason = ?, updated_at = ? WHERE id = ?").run(reason, updatedAt, id);
    return { ...existing, statusReason: reason, updatedAt };
  }

  /** Reject every pending_approval/approved item to `address` (opt-out). Returns the rejected items. */
  rejectAllTo(address: string, decidedBy: string, reason: string): OutboxItem[] {
    const rows = this.#db
      .prepare(`SELECT id FROM outbox WHERE lower("to") = lower(?) AND status IN ('pending_approval', 'approved')`)
      .all(address) as { id: string }[];
    return rows.map((r) => this.decide(r.id, "rejected", { decidedBy, decisionNote: reason }));
  }

  /**
   * Atomically claim the oldest `approved` item to send: approved -> sending. Each sender claims only its own channels
   * (the email Sender: `email`, the default; the FacebookSender: the `facebook_*` channels).
   */
  claimNextToSend(channels: readonly OutboxChannel[] = ["email"]): OutboxItem | null {
    const claim = this.#db.transaction((): OutboxItem | null => {
      const marks = channels.map(() => "?").join(", ");
      const row = this.#db
        .prepare(`SELECT * FROM outbox WHERE status = 'approved' AND channel IN (${marks}) ORDER BY created_at ASC, rowid ASC LIMIT 1`)
        .get(...channels) as OutboxRow | undefined;
      if (!row) return null;
      const updatedAt = nowIso();
      this.#db.prepare(`UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ?`).run(updatedAt, row.id);
      return mapRow({ ...row, status: "sending", updated_at: updatedAt });
    });
    return claim();
  }

  /**
   * On daemon restart: any email item left "sending" (process died mid-send) goes back to approved. Returns the recovered ids.
   * Facebook items are left alone: re-sending one that may already be live would post it twice (FacebookSender.start handles them).
   */
  recoverSending(channels: readonly OutboxChannel[] = ["email"]): string[] {
    const recover = this.#db.transaction((): string[] => {
      const stale = this.#db
        .prepare(`SELECT id FROM outbox WHERE status = 'sending' AND channel IN (${channels.map(() => "?").join(", ")})`)
        .all(...channels) as { id: string }[];
      const ids: string[] = [];
      for (const { id } of stale) {
        this.decide(id, "approved", { statusReason: "recovered after daemon restart mid-send" });
        ids.push(id);
      }
      return ids;
    });
    return recover();
  }

  /** Count of `sent` items with sentAt >= `since` (rate-limit window), for the given channels (default: email). */
  countSentSince(since: Iso, channels: readonly OutboxChannel[] = ["email"]): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'sent' AND sent_at >= ? AND channel IN (${channels.map(() => "?").join(", ")})`)
      .get(since, ...channels) as { c: number };
    return row.c;
  }

  /** Most recent `n` sent items of the given channels (default: email), newest first (bounce-rate window). */
  lastSent(n: number, channels: readonly OutboxChannel[] = ["email"]): OutboxItem[] {
    const rows = this.#db
      .prepare(`SELECT * FROM outbox WHERE status = 'sent' AND channel IN (${channels.map(() => "?").join(", ")}) ORDER BY sent_at DESC, rowid DESC LIMIT ?`)
      .all(...channels, n) as OutboxRow[];
    return rows.map(mapRow);
  }
}
