// Contact handoff: a won deal moves from the SDR to the Account Manager. One
// operation shared by the `contact_handoff` MCP tool (an agent calls it) and
// POST /v1/admin/contacts/:id/handoff (the human "Won -> hand to AM" button).
// Everything that changes state happens in one SQLite transaction; bus events
// go out after it commits.

import type { Agent, AgentRole, Contact, Task } from "@agyhq/core";
import { ConflictError, NotFoundError, type Db } from "@agyhq/db";
import { cancelThreadTasks } from "./routing.ts";
import { ValidationError } from "./util.ts";

export type HandoffActor =
  | { type: "agent"; agentId: string; taskId: string | null }
  | { type: "human" };

export interface HandoffDeps {
  db: Db;
  emit: (type: string, data: Record<string, unknown>) => void;
  /** Task kinds an agent's template defines; null = unknown, don't validate. */
  taskKindsFor: (agent: Agent) => readonly string[] | null;
  /** Follow-up task kinds to cancel on the thread for the previous owner (their role's `routing.followUpKinds`). */
  followUpKindsFor: (agent: Agent | null) => readonly string[];
}

export interface HandoffArgs {
  contactId: string;
  toRole: "account-manager";
  summary: string;
  actor: HandoffActor;
}

export interface HandoffResult {
  contact: Contact;
  task: Task;
  fromAgentId: string | null;
  toAgentId: string;
}

/** Stages an agent may hand off from; a human may hand off from any stage. */
export const AGENT_HANDOFF_STAGES = ["qualified", "meeting_booked", "replied"] as const;

export const ONBOARD_KIND = "am.onboard";

const ROLE_LABEL: Record<"account-manager", string> = { "account-manager": "Account Manager" };

function defaultAgentId(db: Db, role: "account-manager"): string | null {
  return role === "account-manager" ? db.settings.get().defaultAmAgentId : null;
}

export function handoffContact(deps: HandoffDeps, args: HandoffArgs): HandoffResult {
  const { db } = deps;
  const contact = db.crm.getContact(args.contactId);
  if (!contact) throw new NotFoundError("contact", args.contactId);
  if (!contact.email) throw new ValidationError("contact has no email address, so there is no thread to hand over");
  const email = contact.email.toLowerCase();

  const targetId = defaultAgentId(db, args.toRole);
  if (!targetId) {
    throw new ValidationError(
      `no default ${ROLE_LABEL[args.toRole]} is configured; choose one in Settings (defaultAmAgentId) before handing contacts off`,
    );
  }
  const target = db.agents.get(targetId);
  if (!target || target.status !== "active" || target.role !== (args.toRole as AgentRole)) {
    throw new ValidationError(`the default ${ROLE_LABEL[args.toRole]} "${targetId}" is not an active ${args.toRole} agent; update Settings`);
  }
  const kinds = deps.taskKindsFor(target);
  if (kinds && !kinds.includes(ONBOARD_KIND)) {
    throw new ValidationError(`the ${args.toRole} template does not define "${ONBOARD_KIND}"; cannot start onboarding`);
  }

  const caller = args.actor.type === "agent" ? args.actor.agentId : null;
  if (args.actor.type === "agent") {
    if (!(AGENT_HANDOFF_STAGES as readonly string[]).includes(contact.stage)) {
      throw new ValidationError(
        `contact is in stage "${contact.stage}"; an agent may hand off only from ${AGENT_HANDOFF_STAGES.join(", ")} (a human can hand off from any stage)`,
      );
    }
    if (contact.ownerAgentId && contact.ownerAgentId !== caller) {
      throw new ValidationError(`contact is owned by "${contact.ownerAgentId}", not by you; only the owner can hand it off`);
    }
  }
  if (contact.ownerAgentId === target.id) {
    throw new ConflictError(`contact is already owned by ${target.id}`);
  }

  const fromAgentId = contact.ownerAgentId ?? caller;
  const fromAgent = fromAgentId ? db.agents.get(fromAgentId) : null;
  const threadKey = `contact:${email}`;
  const summary = args.summary.trim();

  const { task, updated, cancelled } = db.transaction(() => {
    db.crm.upsertContact({ email, ownerAgentId: target.id });
    db.crm.setStage(contact.id, "customer", `handed off to ${target.id}`, caller);
    db.crm.addNote(
      "contact",
      contact.id,
      `Handed off from ${fromAgentId ?? "(unassigned)"} to ${target.id}${summary ? `: ${summary}` : "."}`,
      caller,
    );
    const cancelledIds = cancelThreadTasks(db, threadKey, deps.followUpKindsFor(fromAgent));

    const company = contact.companyId ? db.crm.getCompany(contact.companyId) : null;
    const created = db.tasks.create({
      agentId: target.id,
      kind: ONBOARD_KIND,
      title: `Onboard ${contact.name ?? email}`,
      input: {
        contactId: contact.id,
        contactName: contact.name,
        contactEmail: email,
        ...(company ? { companyName: company.name } : {}),
        handoffSummary: summary || "(no summary given)",
        ...(fromAgentId ? { fromAgentId } : {}),
      },
      threadKey,
      createdByAgentId: caller,
      priority: 5,
    });
    db.audit.append({
      kind: "contact.handoff",
      agentId: caller,
      taskId: args.actor.type === "agent" ? args.actor.taskId : null,
      conversationId: null,
      data: {
        contactId: contact.id,
        email,
        fromAgentId,
        toAgentId: target.id,
        fromStage: contact.stage,
        onboardTaskId: created.id,
        cancelledTaskIds: cancelledIds,
        by: caller ? `agent:${caller}` : "human",
        summary: summary.length > 500 ? `${summary.slice(0, 500)}…` : summary,
      },
    });
    return { task: created, updated: db.crm.getContact(contact.id)!, cancelled: cancelledIds };
  });

  for (const id of cancelled) deps.emit("task.transition", { taskId: id, to: "cancelled", reason: "contact handed off" });
  deps.emit("task.created", { taskId: task.id, agentId: target.id });
  deps.emit("contact.handoff", { contactId: contact.id, fromAgentId, toAgentId: target.id, taskId: task.id });
  return { contact: updated, task, fromAgentId, toAgentId: target.id };
}
