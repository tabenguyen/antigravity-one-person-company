// Role-aware routing helpers shared by the inbound router, the handoff and the
// agent-facing API: which task kinds answer a reply / count as follow-ups for a
// role (template.json `routing`), which kinds a role defines, and the roster the
// Chief of Staff triages against. Everything is read from the role templates, so a
// new role needs no code here.

import type { Agent, TaskStatus } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { loadTemplate, type Template } from "@agyhq/workspace";
import type { AgyhqConfig } from "./config.ts";

export interface RoleRouting {
  replyKind: string;
  followUpKinds: string[];
}

export interface RosterEntry {
  agentId: string;
  role: string;
  displayName: string;
  kinds: string[];
}

type TemplateCtx = Pick<AgyhqConfig, "templatesRoot" | "routing">;

function tryLoad(config: TemplateCtx, role: string): Template | null {
  try {
    return loadTemplate(config.templatesRoot, role);
  } catch {
    return null;
  }
}

/** Task kinds a role's template defines; null when the template can't be loaded. */
export function roleTaskKinds(config: TemplateCtx, role: string): string[] | null {
  return tryLoad(config, role)?.taskKinds.map((k) => k.kind) ?? null;
}

/**
 * How replies reach a role: its template's `routing` block, else `config.routing.*` when that reply kind is one the
 * role actually defines (custom SDR templates predating the block), else null — the role never owns contacts
 * (chief-of-staff) or its template is unusable.
 */
export function roleRouting(config: TemplateCtx, role: string): RoleRouting | null {
  const legacy: RoleRouting = { replyKind: config.routing.replyKind, followUpKinds: [config.routing.followUpKind] };
  const tpl = tryLoad(config, role);
  if (!tpl) return role === "sales-sdr" ? legacy : null;
  if (tpl.routing) return { replyKind: tpl.routing.replyKind, followUpKinds: [...tpl.routing.followUpKinds] };
  return tpl.taskKinds.some((k) => k.kind === legacy.replyKind) ? legacy : null;
}

/** An agent that can still be handed work: it exists and isn't archived (paused agents keep their queue). */
export function isAssignable(agent: Agent | null | undefined): agent is Agent {
  return !!agent && agent.status !== "archived";
}

const CANCELLABLE_STATUSES: TaskStatus[] = ["queued", "waiting_approval", "waiting_external"];

/**
 * Cancel unfinished tasks on a thread (all of them, or only the given kinds). Returns the cancelled task ids; callers
 * emit bus events themselves so a surrounding transaction can commit first.
 */
export function cancelThreadTasks(db: Db, threadKey: string | null, kinds?: readonly string[]): string[] {
  if (!threadKey) return [];
  const cancelled: string[] = [];
  const tasks = db.tasks
    .list({ status: CANCELLABLE_STATUSES })
    .filter((t) => t.threadKey === threadKey && (!kinds || kinds.includes(t.kind)));
  for (const t of tasks) {
    try {
      db.tasks.transition(t.id, "cancelled");
      cancelled.push(t.id);
    } catch {
      // already terminal — nothing to cancel.
    }
  }
  return cancelled;
}

/** Active agents (other than chiefs of staff) with the task kinds their role defines — what `cos.triage` may delegate to. */
export function buildRoster(config: TemplateCtx, db: Db): RosterEntry[] {
  const kindsByRole = new Map<string, string[]>();
  const roster: RosterEntry[] = [];
  for (const agent of db.agents.list({ status: "active" })) {
    if (agent.role === "chief-of-staff") continue;
    if (!kindsByRole.has(agent.role)) kindsByRole.set(agent.role, roleTaskKinds(config, agent.role) ?? []);
    roster.push({ agentId: agent.id, role: agent.role, displayName: agent.displayName, kinds: kindsByRole.get(agent.role)! });
  }
  return roster;
}
