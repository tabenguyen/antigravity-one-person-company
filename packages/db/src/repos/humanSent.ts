import type Database from "better-sqlite3";
import type { HumanSentMessage, Iso } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";

type SqliteDb = Database.Database;

interface HumanSentRow {
  id: string;
  external_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string;
  to_address: string | null;
  recipients: string;
  subject: string | null;
  body_text: string;
  thread_key: string | null;
  contact_id: string | null;
  folder: string | null;
  sent_at: string;
  created_at: string;
}

function mapRow(row: HumanSentRow): HumanSentMessage {
  return {
    id: row.id,
    externalId: row.external_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: fromJson<string[]>(row.references, []),
    toAddress: row.to_address,
    recipients: fromJson<string[]>(row.recipients, []),
    subject: row.subject,
    bodyText: row.body_text,
    threadKey: row.thread_key,
    contactId: row.contact_id,
    folder: row.folder,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

export interface CreateHumanSentInput {
  externalId: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  toAddress?: string | null;
  recipients?: string[];
  subject?: string | null;
  bodyText: string;
  threadKey?: string | null;
  contactId?: string | null;
  folder?: string | null;
  sentAt: Iso;
}

/** Messages the mailbox owner sent from their own mail client (Sent-folder sync). */
export class HumanSentRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  /** Insert, or return the existing row (created: false) when this Message-ID was already recorded. */
  insertIfNew(input: CreateHumanSentInput): { message: HumanSentMessage; created: boolean } {
    const existing = this.#db.prepare("SELECT * FROM human_sent WHERE external_id = ?").get(input.externalId) as HumanSentRow | undefined;
    if (existing) return { message: mapRow(existing), created: false };

    const message: HumanSentMessage = {
      id: newId("hsm"),
      externalId: input.externalId,
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? [],
      toAddress: input.toAddress ?? null,
      recipients: input.recipients ?? [],
      subject: input.subject ?? null,
      bodyText: input.bodyText,
      threadKey: input.threadKey ?? null,
      contactId: input.contactId ?? null,
      folder: input.folder ?? null,
      sentAt: input.sentAt,
      createdAt: nowIso(),
    };
    this.#db
      .prepare(
        `INSERT INTO human_sent
           (id, external_id, message_id, in_reply_to, "references", to_address, recipients, subject, body_text,
            thread_key, contact_id, folder, sent_at, created_at)
         VALUES
           (@id, @externalId, @messageId, @inReplyTo, @references, @toAddress, @recipients, @subject, @bodyText,
            @threadKey, @contactId, @folder, @sentAt, @createdAt)`,
      )
      .run({ ...message, references: toJson(message.references), recipients: toJson(message.recipients) });
    return { message, created: true };
  }

  get(id: string): HumanSentMessage | null {
    const row = this.#db.prepare("SELECT * FROM human_sent WHERE id = ?").get(id) as HumanSentRow | undefined;
    return row ? mapRow(row) : null;
  }

  findByMessageId(messageId: string): HumanSentMessage | null {
    const row = this.#db.prepare("SELECT * FROM human_sent WHERE message_id = ?").get(messageId) as HumanSentRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Newest first. */
  listByThreadKey(threadKey: string, limit = 20): HumanSentMessage[] {
    const rows = this.#db
      .prepare("SELECT * FROM human_sent WHERE thread_key = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?")
      .all(threadKey, limit) as HumanSentRow[];
    return rows.map(mapRow);
  }

  /** Newest first, for anything addressed to `address` (To or Cc). */
  listTo(address: string, limit = 20): HumanSentMessage[] {
    const rows = this.#db
      .prepare(`SELECT * FROM human_sent WHERE recipients LIKE ? ESCAPE '\\' ORDER BY sent_at DESC, rowid DESC LIMIT ?`)
      .all(`%"${address.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}"%`, limit) as HumanSentRow[];
    return rows.map(mapRow).filter((m) => m.recipients.includes(address.toLowerCase()));
  }

  /** The newest time a human emailed `address` from their own client, or null. */
  lastSentTo(address: string): Iso | null {
    return this.listTo(address, 1)[0]?.sentAt ?? null;
  }

  count(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS c FROM human_sent").get() as { c: number }).c;
  }
}
