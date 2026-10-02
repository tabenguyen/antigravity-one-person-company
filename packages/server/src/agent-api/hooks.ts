// Hook route handlers: /v1/hooks/pre-tool-use, /v1/hooks/audit,
// /v1/hooks/context, /v1/hooks/stop. See docs/PHASE0.md D5 for the role of
// each hook and packages/hooks/README.md for exactly what @agyhq/hooks sends.

import path from "node:path";
import type { Hono } from "hono";
import { AuditRequest, ContextRequest, HOOK_ROUTES, PreToolUseRequest, StopRequest } from "@agyhq/core";
import type { AuditKind } from "@agyhq/core";
import { err, ok } from "./envelope.ts";
import { handleError } from "./errors.ts";
import { evaluatePolicy } from "./policy.ts";
import { truncatedJson, truncatedString } from "./audit-util.ts";
import { readJsonBody } from "./body.ts";
import type { ResolvedDeps } from "./deps.ts";
import { attachmentDirForTask } from "../attachments.ts";

/**
 * Directories an agent's file tools may read: its workspace, agy's per-conversation
 * brain dir (agy spills large tool outputs, e.g. fetched web pages, there), and the
 * MCP tool-schema dirs agy writes for servers the agent is allowed to call, plus any
 * `extraRoots` (e.g. the saved attachments of the inbound email the task came from).
 */
export function allowedRootsFor(
  agent: { workspacePath: string; policy: { mcp: { server: string }[] } },
  conversationId: string | null,
  agyStateDir: string,
  extraRoots: string[] = [],
): string[] {
  const roots = [agent.workspacePath, ...extraRoots];
  if (conversationId) roots.push(path.join(agyStateDir, "brain", conversationId));
  for (const server of new Set(agent.policy.mcp.map((m) => m.server))) roots.push(path.join(agyStateDir, "mcp", server));
  return roots;
}

/** Cap on the total characters returned in /v1/hooks/context `messages[]` (see task brief). */
const MAX_CONTEXT_CHARS = 3000;

export function registerHookRoutes(app: Hono, deps: ResolvedDeps): void {
  app.post(HOOK_ROUTES.preToolUse, async (c) => {
    const { agentId, taskId, agent } = c.get("auth");
    const read = await readJsonBody(c);
    if (!read.ok) return err(c, "invalid_request", "request body must be JSON");
    const parsed = PreToolUseRequest.safeParse(read.body);
    if (!parsed.success) return handleError(c, parsed.error);
    const { conversationId, toolName, parameters } = parsed.data;

    const attachmentDir = deps.attachmentsRoot ? attachmentDirForTask(deps.attachmentsRoot, deps.db.tasks.get(taskId)) : null;
    const decision = evaluatePolicy(agent.policy, toolName, parameters, {
      allowedRoots: allowedRootsFor(agent, conversationId, deps.agyStateDir, attachmentDir ? [attachmentDir] : []),
    });

    const mcpServer = toolName === "call_mcp_tool" && typeof parameters["ServerName"] === "string" ? parameters["ServerName"] : null;
    const mcpTool = toolName === "call_mcp_tool" && typeof parameters["ToolName"] === "string" ? parameters["ToolName"] : null;

    deps.db.audit.append({
      kind: decision.decision === "allow" ? "tool.pre" : "tool.denied",
      agentId,
      taskId,
      conversationId,
      data: {
        toolName,
        ...(mcpServer ? { mcpServer, mcpTool } : {}),
        parameters: truncatedJson(parameters, 2000),
        ...(decision.decision === "deny" ? { reason: decision.reason } : {}),
      },
    });

    return ok(c, decision);
  });

  app.post(HOOK_ROUTES.audit, async (c) => {
    const { agentId, taskId } = c.get("auth");
    const read = await readJsonBody(c);
    if (!read.ok) return err(c, "invalid_request", "request body must be JSON");
    const parsed = AuditRequest.safeParse(read.body);
    if (!parsed.success) return handleError(c, parsed.error);
    const { event, conversationId, payload } = parsed.data;

    // PostToolUse and PostInvocation both arrive here (audit.mjs is shared
    // between the two agy lifecycle events, see packages/hooks/README.md).
    // Both map to the "tool.post" AuditKind; which agy event produced the
    // row is preserved in `data.event` so nothing is lost.
    const kind: AuditKind = "tool.post";
    const toolCall = isRecord(payload) && isRecord(payload["toolCall"]) ? (payload["toolCall"] as Record<string, unknown>) : null;
    const toolName = toolCall && typeof toolCall["name"] === "string" ? (toolCall["name"] as string) : null;
    const errorField = isRecord(payload) && typeof payload["error"] === "string" ? (payload["error"] as string) : "";

    deps.db.audit.append({
      kind,
      agentId,
      taskId,
      conversationId,
      data: {
        event,
        toolName,
        error: errorField ? truncatedString(errorField, 500) : null,
        payload: truncatedJson(payload, 8_000),
      },
    });

    return ok(c, { recorded: true });
  });

  app.post(HOOK_ROUTES.context, async (c) => {
    const { agentId, taskId } = c.get("auth");
    const read = await readJsonBody(c);
    if (!read.ok) return err(c, "invalid_request", "request body must be JSON");
    const parsed = ContextRequest.safeParse(read.body);
    if (!parsed.success) return handleError(c, parsed.error);

    const messages = buildContextMessages(deps, agentId, taskId);
    const totalChars = messages.reduce((n, m) => n + m.length, 0);

    deps.db.audit.append({
      kind: "hook.context",
      agentId,
      taskId,
      conversationId: parsed.data.conversationId,
      data: { messageCount: messages.length, totalChars },
    });

    return ok(c, { messages });
  });

  app.post(HOOK_ROUTES.stop, async (c) => {
    const { agentId, taskId } = c.get("auth");
    const read = await readJsonBody(c);
    if (!read.ok) return err(c, "invalid_request", "request body must be JSON");
    const parsed = StopRequest.safeParse(read.body);
    if (!parsed.success) return handleError(c, parsed.error);
    const { conversationId, transcriptPath, terminationReason } = parsed.data;

    deps.db.audit.append({
      kind: "hook.stop",
      agentId,
      taskId,
      conversationId,
      data: { transcriptPath, terminationReason },
    });

    return ok(c, decideStop());
  });
}

/**
 * Phase 1 stop policy: always let the agent really stop (per the task
 * brief). Kept as its own function — a future policy (e.g. forcing
 * completion of a missing structured TaskResult before allowing a real
 * stop) only has to change this one spot.
 */
function decideStop(): { decision: "stop" } {
  return { decision: "stop" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Builds the short context messages injected before the model's next turn:
 * accepted memories (general, plus any scoped to this task's threadKey) and,
 * for a `contact:<email>` threadKey, a compact CRM summary. Capped at
 * MAX_CONTEXT_CHARS total; returns [] when there's nothing relevant.
 */
function buildContextMessages(deps: ResolvedDeps, agentId: string, taskId: string): string[] {
  const { db } = deps;
  const task = db.tasks.get(taskId);
  const threadKey = task?.threadKey ?? null;

  const messages: string[] = [];

  const memories = db.memory
    .list(agentId, { status: "accepted" })
    .filter((m) => m.subject === null || (threadKey !== null && m.subject === threadKey));
  if (memories.length > 0) {
    const lines = memories.map((m) => `- ${m.subject ? `[${m.subject}] ` : ""}${m.content}`);
    messages.push(`Known memories for this agent:\n${lines.join("\n")}`);
  }

  if (threadKey && threadKey.startsWith("contact:")) {
    const email = threadKey.slice("contact:".length);
    const contact = db.crm.findContacts({ email })[0] ?? null;
    if (contact) {
      const notes = contact.recentNotes.slice(0, 3).map((n) => `  - ${n.body}`);
      messages.push(
        [
          `Contact summary for ${email}:`,
          `  stage: ${contact.stage}`,
          `  company: ${contact.company ? contact.company.name : "(none)"}`,
          notes.length > 0 ? `  recent notes:\n${notes.join("\n")}` : "  recent notes: (none)",
        ].join("\n"),
      );
    }
  }

  return capMessages(messages, MAX_CONTEXT_CHARS);
}

function capMessages(messages: string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const message of messages) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    const text = message.length > remaining ? `${message.slice(0, Math.max(0, remaining - 3))}...` : message;
    if (text.length === 0) break;
    out.push(text);
    used += text.length;
  }
  return out;
}
