import type Database from "better-sqlite3";
import type { MemoryItem, MemoryStatus } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { NotFoundError } from "../errors.ts";

type SqliteDb = Database.Database;

interface MemoryRow {
  id: string;
  agent_id: string;
  subject: string | null;
  content: string;
  status: string;
  created_at: string;
}

function mapRow(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    subject: row.subject,
    content: row.content,
    status: row.status as MemoryStatus,
    createdAt: row.created_at,
  };
}

export interface ListMemoryFilter {
  subject?: string;
  status?: MemoryStatus;
}

export class MemoryRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  propose(agentId: string, content: string, subject: string | null = null): MemoryItem {
    const item: MemoryItem = {
      id: newId("mem"),
      agentId,
      subject,
      content,
      status: "pending",
      createdAt: nowIso(),
    };
    this.#db
      .prepare(
        `INSERT INTO memory (id, agent_id, subject, content, status, created_at)
         VALUES (@id, @agentId, @subject, @content, @status, @createdAt)`,
      )
      .run(item);
    return item;
  }

  list(agentId: string, filter: ListMemoryFilter = {}): MemoryItem[] {
    const clauses: string[] = ["agent_id = @agentId"];
    const params: Record<string, unknown> = { agentId };
    if (filter.subject !== undefined) {
      clauses.push("subject = @subject");
      params.subject = filter.subject;
    }
    if (filter.status) {
      clauses.push("status = @status");
      params.status = filter.status;
    }
    const rows = this.#db
      .prepare(`SELECT * FROM memory WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC`)
      .all(params) as MemoryRow[];
    return rows.map(mapRow);
  }

  setStatus(id: string, status: MemoryStatus): MemoryItem {
    const row = this.#db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as MemoryRow | undefined;
    if (!row) throw new NotFoundError("memory", id);
    this.#db.prepare("UPDATE memory SET status = ? WHERE id = ?").run(status, id);
    return mapRow({ ...row, status });
  }
}
