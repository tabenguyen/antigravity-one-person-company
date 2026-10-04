// MCP tool route handlers: one POST /v1/mcp/<tool> per @agyhq/core McpTools
// entry, called by @agyhq/mcp's company MCP server (see packages/mcp/README.md).
// Body is already shaped like the tool's input by the MCP server, but we
// re-validate here too (never trust a caller, and this is the actual
// enforcement point — the MCP server's re-validation is defense in depth on
// its side, this is defense in depth on ours).

import type { Hono } from "hono";
import { COMPANY_MCP_SERVER, McpTools, mcpRoute } from "@agyhq/core";
import type { ContactView, KbScope, McpToolInput, McpToolName, McpToolOutputs } from "@agyhq/core";
import { err, ok } from "./envelope.ts";
import { handleError, HttpError } from "./errors.ts";
import { evaluatePolicy } from "./policy.ts";
import { truncatedString } from "./audit-util.ts";
import { readJsonBody } from "./body.ts";
import type { ResolvedDeps } from "./deps.ts";
import { handoffContact } from "../handoff.ts";
import { draftEmail } from "./outbox-draft.ts";
import { draftFbPost, draftFbReply, proposeFbHide } from "./fb-draft.ts";

const SYSTEM_MANAGED_STAGES = new Set(["contacted", "replied"]);

export function registerMcpRoutes(app: Hono, deps: ResolvedDeps): void {
  registerTool(app, deps, "kb_search", async (ctx, input) => {
    const scopes: KbScope[] = ["company", `role:${ctx.agent.role}`, `agent:${ctx.agent.id}`];
    const results = ctx.db.kb.search(input.query, scopes, input.limit ?? 10);
    ctx.db.audit.append({
      kind: "kb.search",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { query: truncatedString(input.query, 300), limit: input.limit ?? 10, resultCount: results.length },
    });
    return { results } satisfies McpToolOutputs["kb_search"];
  });

  registerTool(app, deps, "memory_list", async (ctx, input) => {
    const items = ctx.db.memory.list(ctx.agentId, { status: "accepted", subject: input.subject });
    return { items } satisfies McpToolOutputs["memory_list"];
  });

  registerTool(app, deps, "memory_propose", async (ctx, input) => {
    const item = ctx.db.memory.propose(ctx.agentId, input.content, input.subject ?? null);
    ctx.db.audit.append({
      kind: "memory.proposed",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { id: item.id, subject: item.subject, content: truncatedString(input.content, 500) },
    });
    ctx.deps.emit("memory.proposed", { id: item.id, agentId: ctx.agentId, subject: item.subject });
    return { item } satisfies McpToolOutputs["memory_propose"];
  });

  registerTool(app, deps, "crm_find_contact", async (ctx, input) => {
    const contacts = ctx.db.crm.findContacts(input);
    return { contacts } satisfies McpToolOutputs["crm_find_contact"];
  });

  registerTool(app, deps, "crm_upsert_contact", async (ctx, input) => {
    const existing: ContactView | null = ctx.db.crm.findContacts({ email: input.email })[0] ?? null;
    // Set ownerAgentId to the caller only if the contact doesn't already have one.
    const ownerAgentId = existing?.ownerAgentId ? undefined : ctx.agentId;
    // Default source to "agent" only for a brand-new contact that didn't specify one;
    // never overwrite an existing contact's source unless the caller explicitly did.
    const source = input.source ?? (existing ? undefined : "agent");
    const { contact, created } = ctx.db.crm.upsertContact({
      email: input.email,
      name: input.name,
      title: input.title,
      phone: input.phone,
      linkedinUrl: input.linkedinUrl,
      language: input.language,
      source,
      ownerAgentId,
      companyName: input.companyName,
      companyDomain: input.companyDomain,
      attributes: input.attributes,
    });
    return { contact, created } satisfies McpToolOutputs["crm_upsert_contact"];
  });

  registerTool(app, deps, "crm_add_note", async (ctx, input) => {
    const contact = ctx.db.crm.getContact(input.contactId);
    if (!contact) throw new HttpError("not_found", `contact not found: ${input.contactId}`);
    const note = ctx.db.crm.addNote("contact", input.contactId, input.body, ctx.agentId);
    return { note } satisfies McpToolOutputs["crm_add_note"];
  });

  registerTool(app, deps, "crm_set_stage", async (ctx, input) => {
    // "contacted" and "replied" are facts the daemon records itself (the sender on an actual send,
    // the inbound pipeline on an actual reply). An agent setting them would misstate the pipeline,
    // e.g. marking a lead contacted while its draft still awaits approval.
    if (SYSTEM_MANAGED_STAGES.has(input.stage)) {
      throw new HttpError(
        "invalid_request",
        `stage "${input.stage}" is set automatically when an email is actually sent / a reply arrives; don't set it yourself`,
      );
    }
    const contact = ctx.db.crm.setStage(input.contactId, input.stage, input.reason, ctx.agentId);
    return { contact } satisfies McpToolOutputs["crm_set_stage"];
  });

  registerTool(app, deps, "task_create", async (ctx, input) => {
    const assigneeAgentId = input.assigneeAgentId ?? ctx.agentId;
    const assignee = ctx.db.agents.get(assigneeAgentId);
    if (!assignee) throw new HttpError("not_found", `agent not found: ${assigneeAgentId}`);
    if (assignee.status !== "active") {
      throw new HttpError("invalid_request", `assignee agent "${assigneeAgentId}" is not active`);
    }
    const validKinds = ctx.deps.taskKindsFor(assignee);
    if (validKinds && !validKinds.includes(input.kind)) {
      throw new HttpError(
        "invalid_request",
        `unknown task kind "${input.kind}" for agent "${assigneeAgentId}"; valid kinds: ${validKinds.join(", ")}`,
      );
    }

    const parentTask = ctx.db.tasks.get(ctx.taskId);
    const threadKey = input.threadKey ?? parentTask?.threadKey ?? null;

    const childCount = (
      ctx.db.sqlite.prepare("SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ?").get(ctx.taskId) as { c: number }
    ).c;
    if (childCount >= 20) {
      throw new HttpError("conflict", `task ${ctx.taskId} has already created ${childCount} child tasks (limit 20); refusing to create more`);
    }

    const wakeAt =
      input.afterHours != null ? new Date(ctx.deps.now().getTime() + input.afterHours * 3_600_000).toISOString() : null;

    const task = ctx.db.tasks.create({
      agentId: assigneeAgentId,
      kind: input.kind,
      title: input.title,
      input: input.input,
      threadKey,
      parentTaskId: ctx.taskId,
      createdByAgentId: ctx.agentId,
      wakeAt,
    });
    return { task } satisfies McpToolOutputs["task_create"];
  });

  registerTool(app, deps, "contact_handoff", async (ctx, input) => {
    const result = handoffContact(
      { db: ctx.db, emit: ctx.deps.emit, taskKindsFor: ctx.deps.taskKindsFor, followUpKindsFor: ctx.deps.followUpKindsFor },
      { contactId: input.contactId, toRole: input.toRole, summary: input.summary, actor: { type: "agent", agentId: ctx.agentId, taskId: ctx.taskId } },
    );
    return result satisfies McpToolOutputs["contact_handoff"];
  });

  registerTool(app, deps, "outbox_draft_email", async (ctx, input) => draftEmail(ctx, input));
  registerTool(app, deps, "fb_draft_post", async (ctx, input) => draftFbPost(ctx, input));
  registerTool(app, deps, "fb_draft_reply", async (ctx, input) => draftFbReply(ctx, input));
  registerTool(app, deps, "fb_propose_hide", async (ctx, input) => proposeFbHide(ctx, input));
}

interface ToolCtx {
  db: ResolvedDeps["db"];
  deps: ResolvedDeps;
  agentId: string;
  taskId: string;
  agent: import("@agyhq/core").Agent;
}

function registerTool<N extends McpToolName>(
  app: Hono,
  deps: ResolvedDeps,
  name: N,
  handler: (ctx: ToolCtx, input: McpToolInput<N>) => Promise<McpToolOutputs[N]>,
): void {
  app.post(mcpRoute(name), async (c) => {
    const { agentId, taskId, agent } = c.get("auth");

    // Belt-and-suspenders (PHASE0.md D3 layer 3): this must hold even if a
    // workspace's hooks.json is missing/broken and PreToolUse never ran, so
    // we re-run the exact same policy check a correctly-wired PreToolUse
    // hook would have made, keyed off the route itself rather than trusting
    // that the caller was already vetted.
    const authz = evaluatePolicy(agent.policy, "call_mcp_tool", { ServerName: COMPANY_MCP_SERVER, ToolName: name });
    if (authz.decision === "deny") {
      deps.db.audit.append({
        kind: "tool.denied",
        agentId,
        taskId,
        conversationId: null,
        data: { layer: "mcp", toolName: "call_mcp_tool", mcpServer: COMPANY_MCP_SERVER, mcpTool: name, reason: authz.reason },
      });
      return err(c, "forbidden", authz.reason);
    }

    const read = await readJsonBody(c);
    if (!read.ok) return err(c, "invalid_request", "request body must be JSON");

    const schema = McpTools[name].input;
    const parsed = schema.safeParse(read.body);
    if (!parsed.success) return handleError(c, parsed.error);

    try {
      const data = await handler({ db: deps.db, deps, agentId, taskId, agent }, parsed.data);
      return ok(c, data);
    } catch (error) {
      return handleError(c, error);
    }
  });
}
