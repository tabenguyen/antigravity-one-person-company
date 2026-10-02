// HTTP contract between the agy-hq daemon and the processes agy spawns
// (hook scripts and the company MCP server). Both run inside an agy process
// whose env carries the AGYHQ_* variables below.
//
// Transport: JSON over HTTP, POST only, base = AGYHQ_API_URL (e.g. http://127.0.0.1:7317).
// Every request carries:
//   authorization: Bearer <AGYHQ_TOKEN>
//   x-agyhq-agent-id: <AGYHQ_AGENT_ID>
//   x-agyhq-task-id: <AGYHQ_TASK_ID>     (optional)
// Every response body is an ApiEnvelope.

import { z } from "zod";
import type { KbHit, MemoryItem, Contact, Company, Note, OutboxItem, Task, PolicyDecision } from "./domain.ts";

export const ENV = {
  apiUrl: "AGYHQ_API_URL",
  token: "AGYHQ_TOKEN",
  agentId: "AGYHQ_AGENT_ID",
  taskId: "AGYHQ_TASK_ID",
} as const;

export const HEADERS = {
  agentId: "x-agyhq-agent-id",
  taskId: "x-agyhq-task-id",
} as const;

export const DEFAULT_API_PORT = 7317;

/** MCP server name agy sees (call_mcp_tool parameters.ServerName). */
export const COMPANY_MCP_SERVER = "company";

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: ApiErrorCode; message: string } };

export type ApiErrorCode = "unauthorized" | "forbidden" | "not_found" | "invalid_request" | "conflict" | "internal";

// ---------------------------------------------------------------------------
// Hook endpoints — called by @agyhq/hooks scripts.
// Fail-closed rule: if pre-tool-use cannot get an answer, the hook DENIES.

export const HookEvent = z.enum(["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"]);
export type HookEvent = z.infer<typeof HookEvent>;

export const PreToolUseRequest = z.object({
  conversationId: z.string().nullable(),
  toolName: z.string(), // e.g. "view_file" or "call_mcp_tool"
  parameters: z.record(z.unknown()), // for call_mcp_tool: { ServerName, ToolName, Arguments }
});
export type PreToolUseRequest = z.infer<typeof PreToolUseRequest>;
export type PreToolUseResponse = PolicyDecision;

export const AuditRequest = z.object({
  event: HookEvent,
  conversationId: z.string().nullable(),
  payload: z.record(z.unknown()), // raw agy hook stdin payload
});
export type AuditRequest = z.infer<typeof AuditRequest>;
export type AuditResponse = { recorded: true };

export const ContextRequest = z.object({
  conversationId: z.string().nullable(),
});
export type ContextRequest = z.infer<typeof ContextRequest>;
/** Each message becomes one injectSteps[].ephemeralMessage. Keep them short. */
export type ContextResponse = { messages: string[] };

export const StopRequest = z.object({
  conversationId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  terminationReason: z.string().nullable(),
  payload: z.record(z.unknown()),
});
export type StopRequest = z.infer<typeof StopRequest>;
export type StopResponse = { decision: "stop" } | { decision: "continue"; reason: string };

export const HOOK_ROUTES = {
  preToolUse: "/v1/hooks/pre-tool-use",
  audit: "/v1/hooks/audit",
  context: "/v1/hooks/context",
  stop: "/v1/hooks/stop",
} as const;

// ---------------------------------------------------------------------------
// MCP tool endpoints — called by @agyhq/mcp. One route per tool:
//   POST /v1/mcp/<tool_name>   body = tool arguments (validated with the schema below)
// The MCP server exposes exactly these tools, with these input schemas.

const LeadStageZ = z.enum([
  "new",
  "researching",
  "contacted",
  "replied",
  "qualified",
  "meeting_booked",
  "disqualified",
  "nurture",
  "customer",
  "churned",
]);

export const McpTools = {
  kb_search: {
    description: "Search the company, role and personal knowledge base. Returns cited snippets.",
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
    }),
  },
  memory_list: {
    description: "List accepted memories for this agent, optionally filtered by subject (e.g. 'contact:jane@acme.com').",
    input: z.object({ subject: z.string().optional() }),
  },
  memory_propose: {
    description: "Propose a durable memory (a learned fact or preference). A human may review it before it is used.",
    input: z.object({ content: z.string().min(1).max(2000), subject: z.string().optional() }),
  },
  crm_find_contact: {
    description: "Find contacts by email, id, or free-text query (name/company). Returns contacts with their company and recent notes.",
    input: z
      .object({ email: z.string().optional(), id: z.string().optional(), query: z.string().optional() })
      .refine((v) => v.email || v.id || v.query, "one of email, id, query is required"),
  },
  crm_upsert_contact: {
    description: "Create or update a contact (matched by email). Company is matched/created by domain or name.",
    input: z.object({
      email: z.string().email(),
      name: z.string().optional(),
      title: z.string().optional(),
      phone: z.string().optional(),
      linkedinUrl: z.string().optional(),
      language: z.string().optional(),
      source: z.string().optional(),
      companyName: z.string().optional(),
      companyDomain: z.string().optional(),
      attributes: z.record(z.unknown()).optional(),
    }),
  },
  crm_add_note: {
    description: "Attach a note to a contact.",
    input: z.object({ contactId: z.string(), body: z.string().min(1).max(5000) }),
  },
  crm_set_stage: {
    description: "Move a contact to a new lead stage, with a short reason.",
    input: z.object({ contactId: z.string(), stage: LeadStageZ, reason: z.string().min(1) }),
  },
  task_create: {
    description:
      "Create a task for yourself (follow-up later via afterHours) or for another agent (handoff via assigneeAgentId).",
    input: z.object({
      kind: z.string().min(1),
      title: z.string().min(1),
      input: z.record(z.unknown()).default({}),
      assigneeAgentId: z.string().optional(),
      threadKey: z.string().optional(),
      afterHours: z.number().min(0).max(24 * 90).optional(),
    }),
  },
  contact_handoff: {
    description:
      "Hand a won contact over to the Account Manager (they become the owner, stage -> customer, onboarding starts). Allowed from stage qualified, meeting_booked or replied. Include everything the account manager needs to know.",
    input: z.object({
      contactId: z.string(),
      toRole: z.literal("account-manager"),
      summary: z.string().trim().min(1).max(2000),
    }),
  },
  outbox_draft_email: {
    description:
      "Draft an outbound email. It is NOT sent: it goes to the outbox where policy and humans decide. Returns the draft and its status.",
    input: z.object({
      to: z.string().email(),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(10000),
      reason: z.string().min(1).max(500),
      threadKey: z.string().optional(),
    }),
  },
} as const;

export type McpToolName = keyof typeof McpTools;
export type McpToolInput<N extends McpToolName> = z.infer<(typeof McpTools)[N]["input"]>;

export interface ContactView extends Contact {
  company: Company | null;
  recentNotes: Note[];
}

export interface McpToolOutputs {
  kb_search: { results: KbHit[] };
  memory_list: { items: MemoryItem[] };
  memory_propose: { item: MemoryItem };
  crm_find_contact: { contacts: ContactView[] };
  crm_upsert_contact: { contact: ContactView; created: boolean };
  crm_add_note: { note: Note };
  crm_set_stage: { contact: Contact };
  task_create: { task: Task };
  contact_handoff: { contact: Contact; task: Task; fromAgentId: string | null; toAgentId: string };
  outbox_draft_email: { item: OutboxItem };
}

export const mcpRoute = (tool: McpToolName) => `/v1/mcp/${tool}`;
