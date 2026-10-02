import type Database from "better-sqlite3";
import type { Agent, AgentRole, AgentStatus, ToolPolicy, TrustTier } from "@agyhq/core";
import { nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";
import { NotFoundError } from "../errors.ts";

type SqliteDb = Database.Database;

interface AgentRow {
  id: string;
  role: string;
  display_name: string;
  model: string;
  status: string;
  trust_tier: string;
  workspace_path: string;
  manager_id: string | null;
  policy: string;
  max_concurrency: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: AgentRow): Agent {
  return {
    id: row.id,
    role: row.role as AgentRole,
    displayName: row.display_name,
    model: row.model,
    status: row.status as AgentStatus,
    trustTier: row.trust_tier as TrustTier,
    workspacePath: row.workspace_path,
    managerId: row.manager_id,
    policy: fromJson<ToolPolicy>(row.policy, { builtins: [], mcp: [] }),
    maxConcurrency: row.max_concurrency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAgentInput {
  id: string;
  role: AgentRole;
  displayName: string;
  model: string;
  workspacePath: string;
  policy: ToolPolicy;
  status?: AgentStatus;
  trustTier?: TrustTier;
  managerId?: string | null;
  maxConcurrency?: number;
}

export interface UpdateAgentInput {
  displayName?: string;
  model?: string;
  workspacePath?: string;
  policy?: ToolPolicy;
  trustTier?: TrustTier;
  managerId?: string | null;
  maxConcurrency?: number;
}

export interface ListAgentsFilter {
  status?: AgentStatus;
  role?: AgentRole;
}

export class AgentsRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  create(input: CreateAgentInput): Agent {
    const now = nowIso();
    const agent: Agent = {
      id: input.id,
      role: input.role,
      displayName: input.displayName,
      model: input.model,
      status: input.status ?? "active",
      trustTier: input.trustTier ?? "shadow",
      workspacePath: input.workspacePath,
      managerId: input.managerId ?? null,
      policy: input.policy,
      maxConcurrency: input.maxConcurrency ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO agents
           (id, role, display_name, model, status, trust_tier, workspace_path, manager_id, policy, max_concurrency, created_at, updated_at)
         VALUES (@id, @role, @displayName, @model, @status, @trustTier, @workspacePath, @managerId, @policy, @maxConcurrency, @createdAt, @updatedAt)`,
      )
      .run({ ...agent, policy: toJson(agent.policy) });
    return agent;
  }

  get(id: string): Agent | null {
    const row = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(filter: ListAgentsFilter = {}): Agent[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) {
      clauses.push("status = @status");
      params.status = filter.status;
    }
    if (filter.role) {
      clauses.push("role = @role");
      params.role = filter.role;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM agents ${where} ORDER BY created_at ASC`)
      .all(params) as AgentRow[];
    return rows.map(mapRow);
  }

  update(id: string, patch: UpdateAgentInput): Agent {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("agent", id);
    const merged: Agent = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      model: patch.model ?? existing.model,
      workspacePath: patch.workspacePath ?? existing.workspacePath,
      policy: patch.policy ?? existing.policy,
      trustTier: patch.trustTier ?? existing.trustTier,
      managerId: patch.managerId === undefined ? existing.managerId : patch.managerId,
      maxConcurrency: patch.maxConcurrency ?? existing.maxConcurrency,
      updatedAt: nowIso(),
    };
    this.#db
      .prepare(
        `UPDATE agents SET
           display_name = @displayName, model = @model, workspace_path = @workspacePath,
           policy = @policy, trust_tier = @trustTier, manager_id = @managerId,
           max_concurrency = @maxConcurrency, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({ ...merged, policy: toJson(merged.policy) });
    return merged;
  }

  setStatus(id: string, status: AgentStatus): Agent {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("agent", id);
    const updatedAt = nowIso();
    this.#db.prepare("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
    return { ...existing, status, updatedAt };
  }
}
