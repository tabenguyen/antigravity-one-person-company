import type Database from "better-sqlite3";
import type { Iso, Routine, RoutineKind } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";
import { NotFoundError } from "../errors.ts";

type SqliteDb = Database.Database;

interface RoutineRow {
  id: string;
  agent_id: string;
  kind: string;
  name: string;
  schedule: string;
  timezone: string;
  config: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RoutineRow): Routine {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind as RoutineKind,
    name: row.name,
    schedule: row.schedule,
    timezone: row.timezone,
    config: fromJson<Record<string, unknown>>(row.config, {}),
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastResult: row.last_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateRoutineInput {
  agentId: string;
  kind: RoutineKind;
  name: string;
  schedule: string;
  timezone: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  /** Computed by the caller (the repo knows nothing about cron). */
  nextRunAt: Iso | null;
}

export interface UpdateRoutineInput {
  kind?: RoutineKind;
  name?: string;
  schedule?: string;
  timezone?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  nextRunAt?: Iso | null;
  /** Used by the scheduler to record e.g. "missed" without claiming a run happened. */
  lastResult?: string | null;
}

export class RoutinesRepo {
  readonly #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  create(input: CreateRoutineInput): Routine {
    const now = nowIso();
    const routine: Routine = {
      id: newId("rtn"),
      agentId: input.agentId,
      kind: input.kind,
      name: input.name,
      schedule: input.schedule,
      timezone: input.timezone,
      config: input.config ?? {},
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt: input.nextRunAt,
      lastResult: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO routines
           (id, agent_id, kind, name, schedule, timezone, config, enabled, last_run_at, next_run_at, last_result, created_at, updated_at)
         VALUES (@id, @agentId, @kind, @name, @schedule, @timezone, @config, @enabled, @lastRunAt, @nextRunAt, @lastResult, @createdAt, @updatedAt)`,
      )
      .run({ ...routine, config: toJson(routine.config), enabled: routine.enabled ? 1 : 0 });
    return routine;
  }

  get(id: string): Routine | null {
    const row = this.#db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(agentId?: string): Routine[] {
    const rows = (
      agentId
        ? this.#db.prepare("SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC").all(agentId)
        : this.#db.prepare("SELECT * FROM routines ORDER BY created_at ASC, rowid ASC").all()
    ) as RoutineRow[];
    return rows.map(mapRow);
  }

  update(id: string, patch: UpdateRoutineInput): Routine {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("routine", id);
    const merged: Routine = {
      ...existing,
      kind: patch.kind ?? existing.kind,
      name: patch.name ?? existing.name,
      schedule: patch.schedule ?? existing.schedule,
      timezone: patch.timezone ?? existing.timezone,
      config: patch.config ?? existing.config,
      enabled: patch.enabled ?? existing.enabled,
      nextRunAt: patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt,
      lastResult: patch.lastResult === undefined ? existing.lastResult : patch.lastResult,
      updatedAt: nowIso(),
    };
    this.#db
      .prepare(
        `UPDATE routines SET kind = @kind, name = @name, schedule = @schedule, timezone = @timezone, config = @config,
           enabled = @enabled, next_run_at = @nextRunAt, last_result = @lastResult, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({ ...merged, config: toJson(merged.config), enabled: merged.enabled ? 1 : 0 });
    return merged;
  }

  delete(id: string): boolean {
    return this.#db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes > 0;
  }

  /** Enabled routines whose nextRunAt has arrived, oldest-due first. */
  listDue(now: Iso): Routine[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC, rowid ASC`,
      )
      .all(now) as RoutineRow[];
    return rows.map(mapRow);
  }

  /** Record a completed run and the next scheduled time in one statement. */
  markRan(id: string, result: string, nextRunAt: Iso | null, ranAt: Iso = nowIso()): Routine {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("routine", id);
    const updatedAt = nowIso();
    this.#db
      .prepare(
        "UPDATE routines SET last_run_at = ?, last_result = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(ranAt, result, nextRunAt, updatedAt, id);
    return { ...existing, lastRunAt: ranAt, lastResult: result, nextRunAt, updatedAt };
  }
}
