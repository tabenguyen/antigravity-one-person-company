import type Database from "better-sqlite3";
import type { Iso, ShadowRun } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { ConflictError, NotFoundError } from "../errors.ts";

type SqliteDb = Database.Database;

interface ShadowRunRow {
  id: string;
  started_at: string;
  planned_days: number;
  agent_ids: string;
  notes: string | null;
  ended_at: string | null;
}

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function mapRow(row: ShadowRunRow): ShadowRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    plannedDays: row.planned_days,
    agentIds: parseIds(row.agent_ids),
    notes: row.notes,
    endedAt: row.ended_at,
  };
}

export interface CreateShadowRunInput {
  plannedDays: number;
  agentIds: string[];
  notes?: string | null;
  /** Test seam; defaults to now. */
  startedAt?: Iso;
}

export class ShadowRunsRepo {
  readonly #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  /** Start a run. Only one run can be active at a time (ConflictError otherwise). */
  create(input: CreateShadowRunInput): ShadowRun {
    const create = this.#db.transaction((): ShadowRun => {
      const active = this.getActive();
      if (active) throw new ConflictError(`shadow run ${active.id} is already active (started ${active.startedAt}); end it first`);
      const run: ShadowRun = {
        id: newId("shd"),
        startedAt: input.startedAt ?? nowIso(),
        plannedDays: input.plannedDays,
        agentIds: [...new Set(input.agentIds)],
        notes: input.notes ?? null,
        endedAt: null,
      };
      this.#db
        .prepare(
          `INSERT INTO shadow_runs (id, started_at, planned_days, agent_ids, notes, ended_at)
           VALUES (@id, @startedAt, @plannedDays, @agentIds, @notes, NULL)`,
        )
        .run({ ...run, agentIds: JSON.stringify(run.agentIds) });
      return run;
    });
    return create();
  }

  get(id: string): ShadowRun | null {
    const row = this.#db.prepare("SELECT * FROM shadow_runs WHERE id = ?").get(id) as ShadowRunRow | undefined;
    return row ? mapRow(row) : null;
  }

  getActive(): ShadowRun | null {
    const row = this.#db
      .prepare("SELECT * FROM shadow_runs WHERE ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get() as ShadowRunRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Newest first. */
  list(limit = 50): ShadowRun[] {
    const rows = this.#db
      .prepare("SELECT * FROM shadow_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 500))) as ShadowRunRow[];
    return rows.map(mapRow);
  }

  /** End an active run; `notes`, when given, replaces the stored notes. */
  end(id: string, opts: { notes?: string | null; endedAt?: Iso } = {}): ShadowRun {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("shadow run", id);
    if (existing.endedAt) throw new ConflictError(`shadow run ${id} already ended at ${existing.endedAt}`);
    const endedAt = opts.endedAt ?? nowIso();
    const notes = opts.notes !== undefined ? opts.notes : existing.notes;
    this.#db.prepare("UPDATE shadow_runs SET ended_at = ?, notes = ? WHERE id = ?").run(endedAt, notes, id);
    return { ...existing, endedAt, notes };
  }
}
