import type Database from "better-sqlite3";
import type { Iso, Task, TaskResult, TaskStatus } from "@agyhq/core";
import { canTransition, newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";
import { NotFoundError, TaskTransitionError } from "../errors.ts";
import type { AuditRepo } from "./audit.ts";

type SqliteDb = Database.Database;

export interface ClaimOptions {
  /** Return true to leave a queued task unclaimed this round. */
  skip?: (candidate: { priority: number; agentModel: string }) => boolean;
}

interface TaskRow {
  id: string;
  agent_id: string;
  kind: string;
  title: string;
  input: string;
  status: string;
  priority: number;
  thread_key: string | null;
  conversation_id: string | null;
  parent_task_id: string | null;
  created_by_agent_id: string | null;
  attempts: number;
  max_attempts: number;
  wake_at: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: TaskRow): Task {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    title: row.title,
    input: fromJson(row.input, {}),
    status: row.status as TaskStatus,
    priority: row.priority,
    threadKey: row.thread_key,
    conversationId: row.conversation_id,
    parentTaskId: row.parent_task_id,
    createdByAgentId: row.created_by_agent_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    wakeAt: row.wake_at,
    result: fromJson<TaskResult | null>(row.result, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateTaskInput {
  agentId: string;
  kind: string;
  title: string;
  input?: Record<string, unknown>;
  priority?: number;
  threadKey?: string | null;
  conversationId?: string | null;
  parentTaskId?: string | null;
  createdByAgentId?: string | null;
  maxAttempts?: number;
  wakeAt?: Iso | null;
}

export interface ListTasksFilter {
  agentId?: string;
  status?: TaskStatus[];
  limit?: number;
}

/** Fields transition() may update alongside the status move. */
export interface TaskTransitionPatch {
  result?: TaskResult | null;
  error?: string | null;
  conversationId?: string | null;
  wakeAt?: Iso | null;
  /** Replaces the task input (e.g. a human adding guidance before resuming). */
  input?: Record<string, unknown>;
  /** Resets the attempt budget (e.g. a human resuming a task gives it a fresh run budget). */
  attempts?: number;
}

export class TasksRepo {
  #db: SqliteDb;
  #audit: AuditRepo;

  constructor(db: SqliteDb, audit: AuditRepo) {
    this.#db = db;
    this.#audit = audit;
  }

  create(input: CreateTaskInput): Task {
    const now = nowIso();
    const task: Task = {
      id: newId("tsk"),
      agentId: input.agentId,
      kind: input.kind,
      title: input.title,
      input: input.input ?? {},
      status: "queued",
      priority: input.priority ?? 0,
      threadKey: input.threadKey ?? null,
      conversationId: input.conversationId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      wakeAt: input.wakeAt ?? null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO tasks
           (id, agent_id, kind, title, input, status, priority, thread_key, conversation_id, parent_task_id,
            created_by_agent_id, attempts, max_attempts, wake_at, result, error, created_at, updated_at)
         VALUES (@id, @agentId, @kind, @title, @input, @status, @priority, @threadKey, @conversationId, @parentTaskId,
                 @createdByAgentId, @attempts, @maxAttempts, @wakeAt, @result, @error, @createdAt, @updatedAt)`,
      )
      .run({ ...task, input: toJson(task.input), result: toJson(task.result) });
    this.#audit.append({
      kind: "task.created",
      agentId: task.agentId,
      taskId: task.id,
      conversationId: task.conversationId,
      data: { kind: task.kind, title: task.title },
    });
    return task;
  }

  get(id: string): Task | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(filter: ListTasksFilter = {}): Task[] {
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
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC ${limit}`)
      .all(params) as TaskRow[];
    return rows.map(mapRow);
  }

  /** Validate + apply a status move, update updatedAt, append a task.transition audit event. */
  transition(id: string, to: TaskStatus, patch: TaskTransitionPatch = {}): Task {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("task", id);
    if (!canTransition(existing.status, to)) {
      throw new TaskTransitionError(id, existing.status, to);
    }
    const updated: Task = {
      ...existing,
      status: to,
      result: patch.result === undefined ? existing.result : patch.result,
      error: patch.error === undefined ? existing.error : patch.error,
      conversationId: patch.conversationId === undefined ? existing.conversationId : patch.conversationId,
      wakeAt: patch.wakeAt === undefined ? existing.wakeAt : patch.wakeAt,
      input: patch.input === undefined ? existing.input : patch.input,
      attempts: patch.attempts === undefined ? existing.attempts : patch.attempts,
      updatedAt: nowIso(),
    };
    this.#db
      .prepare(
        `UPDATE tasks SET status = @status, result = @result, error = @error,
           conversation_id = @conversationId, wake_at = @wakeAt, input = @input, attempts = @attempts,
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({ ...updated, input: toJson(updated.input), result: toJson(updated.result) });
    this.#audit.append({
      kind: "task.transition",
      agentId: updated.agentId,
      taskId: updated.id,
      conversationId: updated.conversationId,
      data: { from: existing.status, to, patch },
    });
    return updated;
  }

  /** Backoff helper: running/waiting_external -> queued with a wakeAt. */
  requeue(id: string, wakeAt: Iso): Task {
    return this.transition(id, "queued", { wakeAt });
  }

  /** Queued tasks whose wakeAt has arrived (ready to be picked up by claimNext). */
  listDue(now: Iso): Task[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'queued' AND wake_at IS NOT NULL AND wake_at <= ?
         ORDER BY priority DESC, created_at ASC`,
      )
      .all(now) as TaskRow[];
    return rows.map(mapRow);
  }

  /**
   * Atomically claim the best queued task to run:
   * highest priority, then oldest createdAt, where wakeAt is null or due,
   * the agent is active, the agent's running-task count is below maxConcurrency,
   * and no other running task shares its non-null threadKey.
   * Marks it running (attempts += 1) and returns it, or null if nothing is claimable.
   * `opts.skip` drops candidates before those checks (the orchestrator's quota throttle).
   */
  claimNext(now: Iso, opts: ClaimOptions = {}): Task | null {
    const claim = this.#db.transaction((asOf: string): Task | null => {
      const candidates = this.#db
        .prepare(
          `SELECT t.*, a.max_concurrency AS agent_max_concurrency, a.model AS agent_model
           FROM tasks t
           JOIN agents a ON a.id = t.agent_id
           WHERE t.status = 'queued'
             AND a.status = 'active'
             AND (t.wake_at IS NULL OR t.wake_at <= @asOf)
           ORDER BY t.priority DESC, t.created_at ASC`,
        )
        .all({ asOf }) as (TaskRow & { agent_max_concurrency: number; agent_model: string })[];

      const runningCountStmt = this.#db.prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE agent_id = ? AND status = 'running'",
      );
      const threadConflictStmt = this.#db.prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE thread_key = ? AND status = 'running'",
      );

      for (const row of candidates) {
        if (opts.skip?.({ priority: row.priority, agentModel: row.agent_model })) continue;
        const running = (runningCountStmt.get(row.agent_id) as { c: number }).c;
        if (running >= row.agent_max_concurrency) continue;
        if (row.thread_key) {
          const conflict = (threadConflictStmt.get(row.thread_key) as { c: number }).c;
          if (conflict > 0) continue;
        }
        const updatedAt = nowIso();
        this.#db
          .prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
          .run(updatedAt, row.id);
        const claimed = mapRow({ ...row, status: "running", attempts: row.attempts + 1, updated_at: updatedAt });
        this.#audit.append({
          kind: "task.transition",
          agentId: claimed.agentId,
          taskId: claimed.id,
          conversationId: claimed.conversationId,
          data: { from: "queued", to: "running", patch: { attempts: claimed.attempts } },
        });
        return claimed;
      }
      return null;
    });
    return claim.immediate(now);
  }

  /** On daemon restart: any task left "running" (process died) goes back to queued. Returns the recovered ids. */
  recoverStale(): string[] {
    const recover = this.#db.transaction((): string[] => {
      const stale = this.#db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as { id: string }[];
      const ids: string[] = [];
      for (const { id } of stale) {
        this.transition(id, "queued", {});
        ids.push(id);
      }
      return ids;
    });
    return recover.immediate();
  }
}
