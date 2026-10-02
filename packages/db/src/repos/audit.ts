import type Database from "better-sqlite3";
import type { AuditEvent, AuditKind, Iso } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";

type SqliteDb = Database.Database;

interface AuditRow {
  id: string;
  at: string;
  kind: string;
  agent_id: string | null;
  task_id: string | null;
  conversation_id: string | null;
  data: string;
}

function mapRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as AuditKind,
    agentId: row.agent_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    data: fromJson(row.data, {}),
  };
}

export interface ListAuditFilter {
  agentId?: string;
  taskId?: string;
  kind?: AuditKind[];
  since?: Iso;
  limit?: number;
}

export class AuditRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  append(event: Omit<AuditEvent, "id" | "at">): AuditEvent {
    const full: AuditEvent = { id: newId("aud"), at: nowIso(), ...event };
    this.#db
      .prepare(
        `INSERT INTO audit (id, at, kind, agent_id, task_id, conversation_id, data)
         VALUES (@id, @at, @kind, @agentId, @taskId, @conversationId, @data)`,
      )
      .run({ ...full, data: toJson(full.data) });
    return full;
  }

  list(filter: ListAuditFilter = {}): AuditEvent[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.agentId) {
      clauses.push("agent_id = @agentId");
      params.agentId = filter.agentId;
    }
    if (filter.taskId) {
      clauses.push("task_id = @taskId");
      params.taskId = filter.taskId;
    }
    if (filter.kind && filter.kind.length) {
      const names = filter.kind.map((_, i) => `@kind${i}`);
      filter.kind.forEach((k, i) => {
        params[`kind${i}`] = k;
      });
      clauses.push(`kind IN (${names.join(", ")})`);
    }
    if (filter.since) {
      clauses.push("at >= @since");
      params.since = filter.since;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ? "LIMIT @limit" : "";
    if (filter.limit) params.limit = filter.limit;
    const rows = this.#db
      .prepare(`SELECT * FROM audit ${where} ORDER BY at DESC, rowid DESC ${limit}`)
      .all(params) as AuditRow[];
    return rows.map(mapRow);
  }
}
