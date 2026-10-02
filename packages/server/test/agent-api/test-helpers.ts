// Shared test setup: an in-memory db + a sales-sdr-shaped agent + a queued
// task + a run token bound to it, and a thin `request()` wrapper that fills
// in the right auth headers so individual tests only need to vary what's
// different about their case.

import { openDb } from "@agyhq/db";
import type { Db } from "@agyhq/db";
import type { ToolPolicy } from "@agyhq/core";
import type { Hono } from "hono";
import { createAgentApi, RunTokenRegistry } from "../../src/agent-api/index.ts";
import type { AgentApiDeps } from "../../src/agent-api/index.ts";

/** Mirrors templates/sales-sdr/template.json's policy, trimmed to what tests exercise. */
export const SALES_SDR_POLICY: ToolPolicy = {
  builtins: ["view_file", "list_dir", "search_web"],
  mcp: [
    { server: "company", tool: "kb_search" },
    { server: "company", tool: "memory_list" },
    { server: "company", tool: "memory_propose" },
    { server: "company", tool: "crm_find_contact" },
    { server: "company", tool: "crm_upsert_contact" },
    { server: "company", tool: "crm_add_note" },
    { server: "company", tool: "crm_set_stage" },
    { server: "company", tool: "task_create" },
    { server: "company", tool: "outbox_draft_email" },
  ],
};

export interface TestApi {
  db: Db;
  tokens: RunTokenRegistry;
  app: Hono;
  agentId: string;
  taskId: string;
  token: string;
  /** POST a JSON body to `path` with correct auth headers, overridable per-call. */
  request: (path: string, body: unknown, overrides?: Record<string, string | undefined>) => Promise<Response>;
}

export function setupTestApi(deps: Partial<Omit<AgentApiDeps, "db" | "tokens">> = {}): TestApi {
  const db = openDb(":memory:");
  const tokens = new RunTokenRegistry();
  const app = createAgentApi({ db, tokens, ...deps });

  const agentId = "sdr-01";
  db.agents.create({
    id: agentId,
    role: "sales-sdr",
    displayName: "SDR One",
    model: "gemini-3.8-flash-medium",
    workspacePath: "/tmp/workspaces/sdr-01",
    policy: SALES_SDR_POLICY,
  });

  const task = db.tasks.create({ agentId, kind: "sdr.research_lead", title: "Research Acme" });
  const taskId = task.id;
  const token = tokens.issue(agentId, taskId);

  async function request(path: string, body: unknown, overrides: Record<string, string | undefined> = {}): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-agyhq-agent-id": agentId,
      "x-agyhq-task-id": taskId,
      "content-type": "application/json",
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete headers[k];
      else headers[k] = v;
    }
    return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  }

  return { db, tokens, app, agentId, taskId, token, request };
}
