import type Database from "better-sqlite3";
import type { Briefing, Iso } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";

type SqliteDb = Database.Database;

interface BriefingRow {
  id: string;
  agent_id: string;
  task_id: string;
  period_start: string;
  period_end: string;
  markdown: string;
  created_at: string;
}

function mapRow(row: BriefingRow): Briefing {
  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    markdown: row.markdown,
    createdAt: row.created_at,
  };
}

export interface CreateBriefingInput {
  agentId: string;
  taskId: string;
  periodStart: Iso;
  periodEnd: Iso;
  markdown: string;
}

export class BriefingsRepo {
  readonly #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  create(input: CreateBriefingInput): Briefing {
    const briefing: Briefing = { id: newId("brf"), ...input, createdAt: nowIso() };
    this.#db
      .prepare(
        `INSERT INTO briefings (id, agent_id, task_id, period_start, period_end, markdown, created_at)
         VALUES (@id, @agentId, @taskId, @periodStart, @periodEnd, @markdown, @createdAt)`,
      )
      .run(briefing);
    return briefing;
  }

  get(id: string): Briefing | null {
    const row = this.#db.prepare("SELECT * FROM briefings WHERE id = ?").get(id) as BriefingRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** The briefing a task produced, if any (a task produces at most one). */
  getByTaskId(taskId: string): Briefing | null {
    const row = this.#db.prepare("SELECT * FROM briefings WHERE task_id = ?").get(taskId) as BriefingRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Newest first. */
  list(opts: { agentId?: string; limit?: number; since?: Iso } = {}): Briefing[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 500));
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (opts.agentId) {
      clauses.push("agent_id = @agentId");
      params.agentId = opts.agentId;
    }
    if (opts.since) {
      clauses.push("created_at >= @since");
      params.since = opts.since;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM briefings ${where} ORDER BY created_at DESC, rowid DESC LIMIT @limit`)
      .all(params) as BriefingRow[];
    return rows.map(mapRow);
  }
}
