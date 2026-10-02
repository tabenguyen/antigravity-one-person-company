// Shared fixtures for the Phase 4 (roles + coordination) tests: a temp templates root with minimal
// fixture templates for all three roles (so tests never depend on the shipped AM / CoS content),
// an in-memory db with agents created in it, and a config pointing at that root.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRole } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "../src/config.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

interface FixtureRole {
  kinds: string[];
  routing?: { replyKind: string; followUpKinds: string[] };
  mcp?: string[];
}

export const FIXTURE_ROLES: Record<AgentRole, FixtureRole> = {
  "sales-sdr": {
    kinds: ["sdr.research_lead", "sdr.handle_reply", "sdr.follow_up"],
    routing: { replyKind: "sdr.handle_reply", followUpKinds: ["sdr.follow_up"] },
    mcp: ["task_create", "contact_handoff"],
  },
  "account-manager": {
    kinds: ["am.onboard", "am.handle_message", "am.check_in", "am.account_review"],
    routing: { replyKind: "am.handle_message", followUpKinds: ["am.check_in"] },
    mcp: ["task_create"],
  },
  "chief-of-staff": { kinds: ["cos.triage", "cos.daily_digest"], mcp: ["task_create"] },
};

export function writeFixtureTemplates(root: string, roles: Partial<Record<AgentRole, FixtureRole>> = FIXTURE_ROLES): void {
  for (const [role, spec] of Object.entries(roles) as [AgentRole, FixtureRole][]) {
    const dir = path.join(root, role);
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `# ${role}\n`);
    fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${role}\ndescription: fixture\n---\nFixture ${role}.\n`);
    fs.writeFileSync(path.join(dir, "result-schema.json"), JSON.stringify({ type: "object", properties: { status: { type: "string" }, summary: { type: "string" } } }));
    for (const kind of spec.kinds) fs.writeFileSync(path.join(dir, "prompts", `${kind}.md`), `Do ${kind}.\n`);
    fs.writeFileSync(
      path.join(dir, "template.json"),
      JSON.stringify({
        role,
        description: `fixture ${role}`,
        defaultModel: "m",
        policy: { builtins: ["view_file"], mcp: (spec.mcp ?? []).map((tool) => ({ server: "company", tool })) },
        resultSchema: "result-schema.json",
        taskKinds: spec.kinds.map((kind) => ({ kind, description: `fixture ${kind}`, prompt: `prompts/${kind}.md` })),
        ...(spec.routing ? { routing: spec.routing } : {}),
      }),
    );
  }
}

export interface Phase4Env {
  config: AgyhqConfig;
  db: Db;
  templatesRoot: string;
}

export function makePhase4Env(overrides: Partial<AgyhqConfig> = {}): Phase4Env {
  const templatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-p4-tpl-"));
  writeFixtureTemplates(templatesRoot);
  return { config: makeTestConfig({ templatesRoot, ...overrides }), db: openTestDb(), templatesRoot };
}

export function addAgent(db: Db, id: string, role: AgentRole, status: "active" | "paused" | "archived" = "active") {
  const agent = db.agents.create({ id, role, displayName: id, model: "m", workspacePath: `/tmp/${id}`, policy: { builtins: [], mcp: [] } });
  return status === "active" ? agent : db.agents.setStatus(id, status);
}
