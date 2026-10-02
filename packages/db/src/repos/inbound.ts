import type Database from "better-sqlite3";
import type { Iso, InboundClassification, InboundEvent, InboundSource, InboundStatus } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";
import { NotFoundError } from "../errors.ts";

type SqliteDb = Database.Database;

interface InboundRow {
  id: string;
  source: string;
  external_id: string;
  from_address: string | null;
  from_name: string | null;
  to_address: string | null;
  subject: string | null;
  body_text: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string;
  thread_key: string | null;
  contact_id: string | null;
  classification: string;
  status: string;
  status_reason: string | null;
  routed_task_id: string | null;
  payload: string;
  received_at: string;
  created_at: string;
}

function mapRow(row: InboundRow): InboundEvent {
  return {
    id: row.id,
    source: row.source as InboundSource,
    externalId: row.external_id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddress: row.to_address,
    subject: row.subject,
    bodyText: row.body_text,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: fromJson<string[]>(row.references, []),
    threadKey: row.thread_key,
    contactId: row.contact_id,
    classification: row.classification as InboundClassification,
    status: row.status as InboundStatus,
    statusReason: row.status_reason,
    routedTaskId: row.routed_task_id,
    payload: fromJson(row.payload, {}),
    receivedAt: row.received_at,
    createdAt: row.created_at,
  };
}

export interface CreateInboundInput {
  source: InboundSource;
  externalId: string;
  fromAddress?: string | null;
  fromName?: string | null;
  toAddress?: string | null;
  subject?: string | null;
  bodyText: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  threadKey?: string | null;
  contactId?: string | null;
  classification: InboundClassification;
  status?: InboundStatus;
  statusReason?: string | null;
  routedTaskId?: string | null;
  payload?: Record<string, unknown>;
  receivedAt?: Iso;
}

export interface ListInboundFilter {
  status?: InboundStatus;
  classification?: InboundClassification;
  limit?: number;
}

export interface SetStatusPatch {
  statusReason?: string | null;
  routedTaskId?: string | null;
  contactId?: string | null;
}

export class InboundRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  /** Insert, or return the existing row (created: false) if (source, externalId) was already seen — the dedupe gate. */
  insertIfNew(input: CreateInboundInput): { event: InboundEvent; created: boolean } {
    const existing = this.#db
      .prepare("SELECT * FROM inbound_events WHERE source = ? AND external_id = ?")
      .get(input.source, input.externalId) as InboundRow | undefined;
    if (existing) return { event: mapRow(existing), created: false };

    const now = nowIso();
    const event: InboundEvent = {
      id: newId("ibe"),
      source: input.source,
      externalId: input.externalId,
      fromAddress: input.fromAddress ?? null,
      fromName: input.fromName ?? null,
      toAddress: input.toAddress ?? null,
      subject: input.subject ?? null,
      bodyText: input.bodyText,
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? [],
      threadKey: input.threadKey ?? null,
      contactId: input.contactId ?? null,
      classification: input.classification,
      status: input.status ?? "received",
      statusReason: input.statusReason ?? null,
      routedTaskId: input.routedTaskId ?? null,
      payload: input.payload ?? {},
      receivedAt: input.receivedAt ?? now,
      createdAt: now,
    };

    try {
      this.#db
        .prepare(
          `INSERT INTO inbound_events
             (id, source, external_id, from_address, from_name, to_address, subject, body_text,
              message_id, in_reply_to, "references", thread_key, contact_id, classification, status,
              status_reason, routed_task_id, payload, received_at, created_at)
           VALUES
             (@id, @source, @externalId, @fromAddress, @fromName, @toAddress, @subject, @bodyText,
              @messageId, @inReplyTo, @references, @threadKey, @contactId, @classification, @status,
              @statusReason, @routedTaskId, @payload, @receivedAt, @createdAt)`,
        )
        .run({ ...event, references: toJson(event.references), payload: toJson(event.payload) });
    } catch {
      // Unique constraint race (concurrent pollers) — the other writer won; return its row.
      const race = this.#db
        .prepare("SELECT * FROM inbound_events WHERE source = ? AND external_id = ?")
        .get(input.source, input.externalId) as InboundRow | undefined;
      if (race) return { event: mapRow(race), created: false };
      throw new Error(`inbound insert failed and no row found for ${input.source}/${input.externalId}`);
    }

    return { event, created: true };
  }

  get(id: string): InboundEvent | null {
    const row = this.#db.prepare("SELECT * FROM inbound_events WHERE id = ?").get(id) as InboundRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(filter: ListInboundFilter = {}): InboundEvent[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) {
      clauses.push("status = @status");
      params.status = filter.status;
    }
    if (filter.classification) {
      clauses.push("classification = @classification");
      params.classification = filter.classification;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ? "LIMIT @limit" : "";
    if (filter.limit) params.limit = filter.limit;
    const rows = this.#db
      .prepare(`SELECT * FROM inbound_events ${where} ORDER BY received_at DESC, rowid DESC ${limit}`)
      .all(params) as InboundRow[];
    return rows.map(mapRow);
  }

  findByMessageId(messageId: string): InboundEvent | null {
    const row = this.#db.prepare("SELECT * FROM inbound_events WHERE message_id = ?").get(messageId) as
      | InboundRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** Most recent inbound events on a thread, newest first — for thread-summary building. */
  listByThreadKey(threadKey: string, limit = 20): InboundEvent[] {
    const rows = this.#db
      .prepare(`SELECT * FROM inbound_events WHERE thread_key = ? ORDER BY received_at DESC, rowid DESC LIMIT ?`)
      .all(threadKey, limit) as InboundRow[];
    return rows.map(mapRow);
  }

  /** Shallow-merges `patch` into the event's payload. */
  patchPayload(id: string, patch: Record<string, unknown>): InboundEvent {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("inbound event", id);
    const payload = { ...existing.payload, ...patch };
    this.#db.prepare("UPDATE inbound_events SET payload = ? WHERE id = ?").run(toJson(payload), id);
    return { ...existing, payload };
  }

  setStatus(id: string, status: InboundStatus, patch: SetStatusPatch = {}): InboundEvent {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("inbound event", id);
    const updated: InboundEvent = {
      ...existing,
      status,
      statusReason: patch.statusReason !== undefined ? patch.statusReason : existing.statusReason,
      routedTaskId: patch.routedTaskId !== undefined ? patch.routedTaskId : existing.routedTaskId,
      contactId: patch.contactId !== undefined ? patch.contactId : existing.contactId,
    };
    this.#db
      .prepare(
        `UPDATE inbound_events SET status = @status, status_reason = @statusReason,
           routed_task_id = @routedTaskId, contact_id = @contactId WHERE id = @id`,
      )
      .run(updated);
    return updated;
  }
}
