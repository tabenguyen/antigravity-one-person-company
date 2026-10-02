// Admin API: everything a human (via `hq` or, later, agy-ui) uses to manage
// agents, tasks, the outbox/memory approval queues, KB, CRM, quota and audit.
// Bearer-authenticated with config.adminToken. Response bodies are always
// @agyhq/core's ApiEnvelope<T>.

import fs from "node:fs";
import { registerReadinessRoutes } from "./admin-readiness.ts";
import { registerSetupWizardRoutes, withSetupDefaults } from "./admin-setup-wizard.ts";
import { registerQualityRoutes } from "./admin-quality.ts";
import { lintOutboxItem } from "./quality/index.ts";
import { registerRoutinesRoutes } from "./admin-routines.ts";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type {
  ApiEnvelope,
  ApiErrorCode,
  AgentRole,
  AgentStatus,
  AuditKind,
  EmailProvider,
  InboundClassification,
  InboundStatus,
  KbScope,
  OutboxStatus,
  TaskStatus,
} from "@agyhq/core";
import { getAgyVersion } from "@agyhq/runner";
import { ConflictError, NotFoundError, OutboxTransitionError, TaskTransitionError, type Db } from "@agyhq/db";
import type { ZodError } from "zod";
import type { AgyhqConfig } from "./config.ts";
import type { EventBus, BusEvent } from "./event-bus.ts";
import { createAgent, rerender, rerenderAll, type ProvisionCtx } from "./provision.ts";
import { roleKbSource, syncKb, syncOneFile } from "./kb-ingest.ts";
import { ingestWebhookLead } from "./inbound.ts";
import { attachmentsRoot, eventAttachments, resolveAttachment } from "./attachments.ts";
import type { EmailPoller } from "./inbound.ts";
import type { EmailRuntime } from "./setup/email-runtime.ts";
import type { SetupJobManager } from "./setup/jobs.ts";
import type { SetupOverrides } from "./admin-setup-wizard.ts";
import { isInQuietHours, type Sender } from "./sender.ts";
import { computeStats } from "./stats.ts";
import { ValidationError } from "./util.ts";
import {
  CreateAgentRequestZ,
  PatchAgentRequestZ,
  CreateTaskRequestZ,
  ResumeTaskRequestZ,
  CompleteTaskRequestZ,
  FollowUpTaskRequestZ,
  KbSearchQueryZ,
  CreateContactRequestZ,
  ImportContactsRequestZ,
  EditOutboxRequestZ,
  ApproveOutboxRequestZ,
  WebhookLeadRequestZ,
  PatchSettingsRequestZ,
  PutKbFileRequestZ,
  DeleteKbFileRequestZ,
  type DaemonStatus,
  type TimelineEntry,
  type TranscriptStep,
} from "./admin-types.ts";

const FINISHED_TASK_STATUSES: TaskStatus[] = ["done", "failed", "cancelled"];

export interface AdminApiDeps {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
  /** Called after a successful agent rerender so the orchestrator drops its cached template (no arg = clear all). */
  onRerender?: (role?: string) => void;
  /** null when no provider is configured (e.g. email.kind = "none"). */
  emailProvider?: EmailProvider | null;
  emailPoller?: EmailPoller | null;
  /** Owns the live provider/poller and hot-swaps them when the setup wizard saves email settings. Wins over emailProvider/emailPoller. */
  emailRuntime?: EmailRuntime;
  /** Setup-wizard generation jobs (shared with the daemon so shutdown can abort them). */
  setupJobs?: SetupJobManager;
  /** Test seams for the setup wizard. */
  setupOverrides?: SetupOverrides;
  sender?: Sender | null;
  runningTasks?: () => number;
  quotaThrottled?: () => boolean;
  startedAt?: string;
}

function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  const body: ApiEnvelope<T> = { ok: true, data };
  return c.json(body, status);
}

function fail(c: Context, code: ApiErrorCode, message: string, status: 400 | 401 | 403 | 404 | 409 | 500) {
  const body: ApiEnvelope<never> = { ok: false, error: { code, message } };
  return c.json(body, status);
}

function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Run a handler and translate the db/provision package's typed errors into ApiEnvelope error responses. */
async function guarded(c: Context, fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const data = await fn();
    return ok(c, data as object);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(c, "not_found", err.message, 404);
    if (err instanceof TaskTransitionError) return fail(c, "conflict", err.message, 409);
    if (err instanceof OutboxTransitionError) return fail(c, "conflict", err.message, 409);
    if (err instanceof ConflictError) return fail(c, "conflict", err.message, 409);
    if (err instanceof ValidationError) return fail(c, "invalid_request", err.message, 400);
    const message = err instanceof Error ? err.message : String(err);
    return fail(c, "internal", message, 500);
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // keep timing independent of length mismatch
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** scope "company" -> config.kbRoot; "role:<role>" -> kbRoot/roles/<role> if it has .md files, else templates/<role>/kb. Throws ValidationError otherwise. */
function kbScopeRoot(config: AgyhqConfig, scope: string): string {
  if (scope === "company") return config.kbRoot;
  const m = scope.match(/^role:([a-z0-9-]+)$/);
  if (m) return roleKbSource(config, m[1]!).dir; // the role's override dir when it has one, else the template kb
  throw new ValidationError(`unsupported kb scope for file editing: "${scope}"`);
}

/** Resolves relPath under root, rejecting any traversal outside it (defense in depth beyond the zod regex). */
function safeKbPath(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ValidationError(`relPath "${relPath}" escapes its scope root`);
  }
  return resolved;
}

export function createAdminApi(rawDeps: AdminApiDeps): Hono {
  const deps = withSetupDefaults(rawDeps);
  const app = new Hono();
  const ctx: ProvisionCtx = { config: deps.config, db: deps.db };
  const startedAt = deps.startedAt ?? new Date().toISOString();
  const currentProvider = () => (deps.emailRuntime ? deps.emailRuntime.provider : (deps.emailProvider ?? null));
  const currentPoller = () => deps.emailPoller ?? deps.emailRuntime?.poller ?? null;

  let verifyCache: { result: { ok: true } | { ok: false; error: string }; at: number; provider: EmailProvider } | null = null;
  const VERIFY_TTL_MS = 30_000;
  async function cachedVerify(): Promise<{ ok: true } | { ok: false; error: string }> {
    const provider = currentProvider();
    if (!provider) return { ok: false, error: "no email provider configured" };
    const now = Date.now();
    // The cache is per provider instance: a hot-swapped mailbox must never inherit the old one's health.
    if (verifyCache && verifyCache.provider === provider && now - verifyCache.at < VERIFY_TTL_MS) return verifyCache.result;
    const result = await provider.verify();
    verifyCache = { result, at: now, provider };
    return result;
  }

  // Bearer admin token for every /v1/admin/* route, except GET /v1/admin/events also
  // accepts ?access_token= — EventSource (used by the UI) can't set custom headers.
  app.use("/v1/admin/*", async (c, next) => {
    const header = c.req.header("authorization") ?? c.req.header("Authorization");
    const match = header?.match(/^Bearer\s+(.+)$/i);
    const headerToken = match?.[1]?.trim();
    const queryToken = c.req.path === "/v1/admin/events" ? c.req.query("access_token") : undefined;
    const token = headerToken ?? queryToken;
    if (!token || !timingSafeEqualStr(token, deps.config.adminToken)) {
      return fail(c, "unauthorized", "missing or invalid admin bearer token", 401);
    }
    await next();
  });

  // Phase 3 route modules register first so they can supersede older routes
  // (killswitch readiness gate, reject with category).
  registerSetupWizardRoutes(app, deps);
  registerReadinessRoutes(app, deps);
  registerQualityRoutes(app, deps);
  registerRoutinesRoutes(app, deps);

  // -- Agents --------------------------------------------------------------

  app.get("/v1/admin/agents", (c) => {
    const status = c.req.query("status") as AgentStatus | undefined;
    const role = c.req.query("role") as AgentRole | undefined;
    return guarded(c, () => ({ agents: deps.db.agents.list({ status, role }) }));
  });

  app.post("/v1/admin/agents", async (c) => {
    const parsed = CreateAgentRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const agent = createAgent(ctx, parsed.data);
      deps.bus.emit("agent.created", { agentId: agent.id });
      return { agent };
    });
  });

  app.get("/v1/admin/agents/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const agent = deps.db.agents.get(id);
      if (!agent) throw new NotFoundError("agent", id);
      return { agent };
    });
  });

  app.patch("/v1/admin/agents/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = PatchAgentRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const existing = deps.db.agents.get(id);
      if (!existing) throw new NotFoundError("agent", id);
      let agent = existing;
      if (parsed.data.status) agent = deps.db.agents.setStatus(id, parsed.data.status);
      const { status: _status, ...rest } = parsed.data;
      if (Object.keys(rest).length > 0) agent = deps.db.agents.update(id, rest);
      deps.bus.emit("agent.updated", { agentId: id, patch: parsed.data });
      return { agent };
    });
  });

  app.post("/v1/admin/agents/:id/rerender", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const { agent, files } = rerender(ctx, id);
      deps.onRerender?.(agent.role);
      deps.bus.emit("agent.rerendered", { agentId: id, fileCount: files.length });
      return { agent, files };
    });
  });

  app.post("/v1/admin/agents/rerender-all", (c) =>
    guarded(c, () => {
      const results = rerenderAll(ctx);
      if (results.some((r) => r.ok)) deps.onRerender?.();
      deps.bus.emit("agent.rerendered-all", { results });
      return { results };
    }),
  );

  // -- Tasks -----------------------------------------------------------------

  app.get("/v1/admin/tasks", (c) => {
    const agentId = c.req.query("agentId");
    const statusParam = c.req.query("status");
    const status = statusParam ? (statusParam.split(",") as TaskStatus[]) : undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    return guarded(c, () => ({ tasks: deps.db.tasks.list({ agentId, status, limit }) }));
  });

  app.post("/v1/admin/tasks", async (c) => {
    const parsed = CreateTaskRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      if (!deps.db.agents.get(parsed.data.agentId)) {
        throw new NotFoundError("agent", parsed.data.agentId);
      }
      const task = deps.db.tasks.create(parsed.data);
      deps.bus.emit("task.created", { taskId: task.id, agentId: task.agentId });
      return { task };
    });
  });

  app.get("/v1/admin/tasks/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const task = deps.db.tasks.get(id);
      if (!task) throw new NotFoundError("task", id);
      const audit = deps.db.audit.list({ taskId: id });
      return { task, audit };
    });
  });

  app.post("/v1/admin/tasks/:id/cancel", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const task = deps.db.tasks.transition(id, "cancelled");
      deps.bus.emit("task.transition", { taskId: id, to: "cancelled" });
      return { task };
    });
  });

  app.post("/v1/admin/tasks/:id/retry", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const task = deps.db.tasks.transition(id, "queued", { wakeAt: null, error: null });
      deps.bus.emit("task.transition", { taskId: id, to: "queued", reason: "manual retry" });
      return { task };
    });
  });

  // A task the agent handed back (needs_human -> waiting_approval) is resolved by a human:
  // resume it with guidance, mark it done, or cancel it (the cancel route above).
  app.post("/v1/admin/tasks/:id/resume", async (c) => {
    const id = c.req.param("id");
    const parsed = ResumeTaskRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const existing = deps.db.tasks.get(id);
      if (!existing) throw new NotFoundError("task", id);
      if (existing.status !== "waiting_approval") {
        throw new ConflictError(`task is ${existing.status}; only a task waiting for a human decision can be resumed`);
      }
      const input = {
        ...existing.input,
        humanGuidance: parsed.data.guidance,
        previousSummary: existing.result?.summary ?? null,
      };
      const task = deps.db.tasks.transition(id, "queued", { input, attempts: 0, wakeAt: null, error: null });
      deps.bus.emit("task.transition", { taskId: id, to: "queued", reason: "resumed with human guidance" });
      return { task };
    });
  });

  // A finished task can't be reopened (done/cancelled are terminal), so continuing it means a
  // child task that carries the original input plus the reviewer's instruction.
  app.post("/v1/admin/tasks/:id/follow-up", async (c) => {
    const id = c.req.param("id");
    const parsed = FollowUpTaskRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const parent = deps.db.tasks.get(id);
      if (!parent) throw new NotFoundError("task", id);
      if (!FINISHED_TASK_STATUSES.includes(parent.status)) {
        throw new ConflictError(`task is ${parent.status}; only a finished task can get a follow-up`);
      }
      const task = deps.db.tasks.create({
        agentId: parent.agentId,
        kind: parent.kind,
        title: `Follow-up: ${parent.title.replace(/^(Follow-up: )+/, "")}`,
        input: {
          ...parent.input,
          humanGuidance: parsed.data.guidance,
          previousSummary: parent.result?.summary ?? parent.error ?? null,
        },
        priority: parent.priority,
        threadKey: parent.threadKey,
        parentTaskId: parent.id,
      });
      deps.bus.emit("task.created", { taskId: task.id, agentId: task.agentId });
      return { task };
    });
  });

  app.post("/v1/admin/tasks/:id/complete", async (c) => {
    const id = c.req.param("id");
    const parsed = CompleteTaskRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const existing = deps.db.tasks.get(id);
      if (!existing) throw new NotFoundError("task", id);
      if (existing.status !== "waiting_approval") {
        throw new ConflictError(`task is ${existing.status}; only a task waiting for a human decision can be marked done`);
      }
      const note = parsed.data.note || "Resolved manually by admin.";
      const result = {
        status: "done" as const,
        summary: note,
        followUp: null,
        data: { ...existing.result?.data, resolvedBy: "admin", agentSummary: existing.result?.summary ?? null },
      };
      const task = deps.db.tasks.transition(id, "done", { result });
      deps.bus.emit("task.transition", { taskId: id, to: "done", reason: "resolved by admin" });
      return { task };
    });
  });

  // -- Outbox ------------------------------------------------------------

  app.get("/v1/admin/outbox", (c) => {
    const agentId = c.req.query("agentId");
    const statusParam = c.req.query("status");
    const status = statusParam ? (statusParam.split(",") as OutboxStatus[]) : undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    return guarded(c, () => ({ items: deps.db.outbox.list({ agentId, status, limit }) }));
  });

  app.patch("/v1/admin/outbox/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = EditOutboxRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const edited = deps.db.outbox.edit(id, parsed.data);
      const item = deps.db.outbox.setLint(id, lintOutboxItem(deps.db, edited)); // re-lint after the human edit
      deps.db.audit.append({
        kind: "outbox.edited",
        agentId: item.agentId,
        taskId: item.taskId,
        conversationId: null,
        data: { id: item.id, subject: item.subject, bodyLength: item.body.length },
      });
      deps.bus.emit("outbox.updated", { outboxId: id, status: item.status, edited: true });
      return { item };
    });
  });

  app.post("/v1/admin/outbox/:id/approve", async (c) => {
    const id = c.req.param("id");
    const parsed = ApproveOutboxRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const existing = deps.db.outbox.get(id);
      if (!existing) throw new NotFoundError("outbox item", id);
      // Lint errors (placeholders, ungrounded prices, forbidden claims, ...) block approval — they can be
      // reintroduced by a human edit. Fix the draft (the PATCH re-lints) or reject it.
      const lintErrors = existing.lint.filter((f) => f.severity === "error");
      if (lintErrors.length > 0) {
        throw new ConflictError(`draft has ${lintErrors.length} blocking issue(s): ${lintErrors.map((f) => f.message).join("; ")}`);
      }
      const agent = deps.db.agents.get(existing.agentId);
      // Shadow-tier agents never actually send: a human "approving" a shadow draft
      // parks it in `held` (terminal) so promoting the agent later can't release it.
      const to: OutboxStatus = agent?.trustTier === "shadow" ? "held" : "approved";
      const decidedBy = parsed.data.reviewer ? `human:${parsed.data.reviewer}` : "human:admin";
      const item = deps.db.outbox.decide(id, to, { decidedBy, decisionNote: parsed.data.note ?? null, decidedAt: new Date().toISOString() });
      deps.db.audit.append({
        kind: to === "held" ? "outbox.held" : "outbox.approved",
        agentId: item.agentId,
        taskId: item.taskId,
        conversationId: null,
        data: { id: item.id, decidedBy },
      });
      deps.bus.emit("outbox.updated", { outboxId: id, status: to });
      return { item };
    });
  });

  // POST /v1/admin/outbox/:id/reject lives in admin-quality.ts (reject with a structured category).

  app.post("/v1/admin/outbox/:id/retry", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const item = deps.db.outbox.decide(id, "approved", { statusReason: null });
      deps.db.audit.append({
        kind: "outbox.approved",
        agentId: item.agentId,
        taskId: item.taskId,
        conversationId: null,
        data: { id: item.id, retried: true },
      });
      deps.bus.emit("outbox.updated", { outboxId: id, status: "approved" });
      return { item };
    });
  });

  // -- Memory --------------------------------------------------------------

  app.get("/v1/admin/memory", (c) => {
    const agentId = c.req.query("agentId");
    const subject = c.req.query("subject");
    const status = (c.req.query("status") ?? "pending") as "pending" | "accepted" | "rejected";
    return guarded(c, () => {
      const agentIds = agentId ? [agentId] : deps.db.agents.list().map((a) => a.id);
      const items = agentIds.flatMap((id) => deps.db.memory.list(id, { subject, status }));
      return { items };
    });
  });

  app.post("/v1/admin/memory/:id/accept", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const item = deps.db.memory.setStatus(id, "accepted");
      deps.bus.emit("memory.updated", { memoryId: id, status: "accepted" });
      return { item };
    });
  });

  app.post("/v1/admin/memory/:id/reject", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const item = deps.db.memory.setStatus(id, "rejected");
      deps.bus.emit("memory.updated", { memoryId: id, status: "rejected" });
      return { item };
    });
  });

  // -- Inbound -----------------------------------------------------------

  app.get("/v1/admin/inbound", (c) => {
    const status = c.req.query("status") as InboundStatus | undefined;
    const classification = c.req.query("classification") as InboundClassification | undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    return guarded(c, () => ({ events: deps.db.inbound.list({ status, classification, limit }) }));
  });

  app.get("/v1/admin/inbound/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const event = deps.db.inbound.get(id);
      if (!event) throw new NotFoundError("inbound event", id);
      return { event };
    });
  });

  // Raw file download for admin review. Always served as a download (never rendered inline by this
  // origin): attachment content is untrusted sender input.
  app.get("/v1/admin/inbound/:id/attachments/:index", (c) => {
    const id = c.req.param("id");
    const event = deps.db.inbound.get(id);
    if (!event) return fail(c, "not_found", `inbound event ${id} not found`, 404);
    const att = eventAttachments(event)[Number(c.req.param("index"))];
    const file = att ? resolveAttachment(attachmentsRoot(deps.config.dataDir), att) : null;
    if (!att || !file || !fs.existsSync(file)) return fail(c, "not_found", "attachment not found", 404);
    const name = att.filename ?? path.basename(file);
    return c.body(fs.readFileSync(file), 200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
    });
  });

  // -- Settings / kill switch / status ----------------------------------

  app.get("/v1/admin/settings", (c) => guarded(c, () => ({ settings: deps.db.settings.get() })));

  app.patch("/v1/admin/settings", async (c) => {
    const parsed = PatchSettingsRequestZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    const body = parsed.data;
    return guarded(c, () => {
      if (body.defaultSdrAgentId && !deps.db.agents.get(body.defaultSdrAgentId)) {
        throw new ValidationError(`agent not found: ${body.defaultSdrAgentId}`);
      }
      const settings = deps.db.settings.patch(body);
      deps.db.audit.append({ kind: "settings.changed", agentId: null, taskId: null, conversationId: null, data: body });
      deps.bus.emit("settings.changed", body);
      return { settings };
    });
  });

  app.get("/v1/admin/status", async (c) => {
    const settings = deps.db.settings.get();
    const [agyVersion, emailHealth] = await Promise.all([getAgyVersion(deps.config.agyBin), cachedVerify()]);
    const emailAddress = "address" in deps.config.email ? deps.config.email.address : null;
    const status: DaemonStatus = {
      version: "0.0.0",
      startedAt,
      agyVersion,
      email: {
        provider: deps.config.email.kind,
        address: emailAddress,
        ok: emailHealth.ok,
        error: emailHealth.ok ? null : emailHealth.error,
        lastPollAt: currentPoller()?.lastPollAt ?? null,
        lastSendAt: deps.sender?.lastSendAt ?? null,
      },
      outboundEnabled: settings.outboundEnabled,
      outboundDisabledReason: settings.outboundDisabledReason,
      inQuietHours: isInQuietHours(settings.quietHours, new Date()),
      quotaThrottled: deps.quotaThrottled?.() ?? false,
      runningTasks: deps.runningTasks?.() ?? 0,
    };
    return guarded(c, () => ({ status }));
  });

  // -- Stats (dashboard) --------------------------------------------------

  app.get("/v1/admin/stats", (c) => {
    const days = Number(c.req.query("days") ?? "7") || 7;
    return guarded(c, () => computeStats(deps.db, days));
  });

  // -- Contact detail / timeline -------------------------------------------

  app.get("/v1/admin/contacts/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const contact = deps.db.crm.contactView(id);
      if (!contact) throw new NotFoundError("contact", id);

      const notes = deps.db.crm.listRecentNotes("contact", id, 100).map((note) => ({ type: "note" as const, at: note.createdAt, note }));
      const outboxItems = contact.email
        ? deps.db.outbox.list({}).filter((i) => i.to.toLowerCase() === contact.email!.toLowerCase())
        : [];
      const outboxEntries = outboxItems.map((item) => ({ type: "outbox" as const, at: item.updatedAt, item }));
      const inboundEvents = deps.db.inbound
        .list({})
        .filter((e) => e.contactId === id || (contact.email && e.fromAddress?.toLowerCase() === contact.email!.toLowerCase()));
      const inboundEntries = inboundEvents.map((event) => ({ type: "inbound" as const, at: event.receivedAt, event }));
      const threadKey = contact.email ? `contact:${contact.email}` : null;
      const tasks = threadKey ? deps.db.tasks.list({}).filter((t) => t.threadKey === threadKey) : [];
      const taskEntries = tasks.map((task) => ({ type: "task" as const, at: task.updatedAt, task }));

      const timeline: TimelineEntry[] = [...notes, ...outboxEntries, ...inboundEntries, ...taskEntries].sort((a, b) =>
        b.at.localeCompare(a.at),
      );
      return { contact, timeline };
    });
  });

  // -- Task transcript --------------------------------------------------

  app.get("/v1/admin/tasks/:id/transcript", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const task = deps.db.tasks.get(id);
      if (!task) throw new NotFoundError("task", id);
      const stopEvents = deps.db.audit.list({ taskId: id, kind: ["hook.stop"] });
      const transcriptPath = (stopEvents[0]?.data as { transcriptPath?: string | null } | undefined)?.transcriptPath ?? null;
      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return { steps: [], transcriptPath: transcriptPath ?? null };
      }
      const raw = fs.readFileSync(transcriptPath, "utf8");
      const steps: TranscriptStep[] = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { index, at: null, source: "unknown", type: "parse_error", text: line.slice(0, 4000) };
          }
          const content = typeof obj.content === "string" ? obj.content : "";
          const toolCalls = Array.isArray(obj.tool_calls)
            ? (obj.tool_calls as { name: string; args: Record<string, unknown> }[])
                .map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`)
                .join("\n")
            : "";
          const text = [content, toolCalls].filter(Boolean).join("\n").slice(0, 4000);
          return {
            index: typeof obj.step_index === "number" ? obj.step_index : index,
            at: typeof obj.created_at === "string" ? obj.created_at : null,
            source: typeof obj.source === "string" ? obj.source : "unknown",
            type: typeof obj.type === "string" ? obj.type : "unknown",
            text,
          };
        });
      return { steps, transcriptPath };
    });
  });

  // -- KB --------------------------------------------------------------------

  app.post("/v1/admin/kb/sync", (c) =>
    guarded(c, () => {
      const summary = syncKb({ config: deps.config, db: deps.db });
      deps.bus.emit("kb.synced", { scanned: summary.scanned, changed: summary.changed, deleted: summary.deleted });
      return summary;
    }),
  );

  app.get("/v1/admin/kb/search", (c) => {
    const parsed = KbSearchQueryZ.safeParse({
      query: c.req.query("query"),
      scopes: c.req.query("scopes"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const scopes = parsed.data.scopes.split(",").filter(Boolean) as KbScope[];
      return { results: deps.db.kb.search(parsed.data.query, scopes, parsed.data.limit ?? 10) };
    });
  });

  app.get("/v1/admin/kb/docs", (c) => {
    const scope = c.req.query("scope") as KbScope | undefined;
    return guarded(c, () => {
      const docs = deps.db.kb.listDocuments(scope).map((doc) => {
        let relPath: string | null = null;
        try {
          const root = kbScopeRoot(deps.config, doc.scope);
          relPath = path.relative(root, doc.sourcePath);
        } catch {
          relPath = null; // e.g. agent-scoped docs aren't editable via this endpoint
        }
        return { id: doc.id, scope: doc.scope, title: doc.title, sourcePath: doc.sourcePath, relPath, updatedAt: doc.updatedAt };
      });
      return { docs };
    });
  });

  app.get("/v1/admin/kb/docs/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const doc = deps.db.kb.getDocument(id);
      if (!doc) throw new NotFoundError("kb document", id);
      let relPath: string | null = null;
      try {
        relPath = path.relative(kbScopeRoot(deps.config, doc.scope), doc.sourcePath);
      } catch {
        relPath = null;
      }
      return {
        doc: { id: doc.id, scope: doc.scope, title: doc.title, sourcePath: doc.sourcePath, relPath, updatedAt: doc.updatedAt, body: doc.body },
      };
    });
  });

  app.put("/v1/admin/kb/files", async (c) => {
    const parsed = PutKbFileRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const root = kbScopeRoot(deps.config, parsed.data.scope);
      const filePath = safeKbPath(root, parsed.data.relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, parsed.data.body, "utf8");

      syncOneFile({ config: deps.config, db: deps.db }, filePath, parsed.data.scope as KbScope);
      const doc = deps.db.kb.listDocuments(parsed.data.scope as KbScope).find((d) => d.sourcePath === filePath);
      if (!doc) throw new Error(`kb file written but not found after sync: ${filePath}`);

      deps.db.audit.append({
        kind: "kb.edited",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { scope: parsed.data.scope, relPath: parsed.data.relPath },
      });
      deps.bus.emit("kb.synced", { scanned: 1, changed: 1, deleted: 0 });
      return { doc: { id: doc.id, scope: doc.scope, title: doc.title, sourcePath: doc.sourcePath, relPath: parsed.data.relPath, updatedAt: doc.updatedAt, body: doc.body } };
    });
  });

  app.delete("/v1/admin/kb/files", async (c) => {
    const parsed = DeleteKbFileRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const root = kbScopeRoot(deps.config, parsed.data.scope);
      const filePath = safeKbPath(root, parsed.data.relPath);
      const doc = deps.db.kb.listDocuments(parsed.data.scope as KbScope).find((d) => d.sourcePath === filePath);
      if (doc) deps.db.kb.deleteDocument(doc.id);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      deps.db.audit.append({
        kind: "kb.edited",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { scope: parsed.data.scope, relPath: parsed.data.relPath, deleted: true },
      });
      deps.bus.emit("kb.synced", { scanned: 0, changed: 0, deleted: doc ? 1 : 0 });
      return { deleted: true };
    });
  });

  // -- Contacts --------------------------------------------------------------

  app.get("/v1/admin/contacts", (c) => {
    const query = c.req.query("query");
    const email = c.req.query("email");
    const id = c.req.query("id");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : 20;
    return guarded(c, () => {
      if (query || email || id) {
        return { contacts: deps.db.crm.findContacts({ query, email, id }, limit) };
      }
      // No filter given: fall back to the raw handle (exposed by @agyhq/db
      // for exactly this kind of "list everything" admin need) to list the
      // most recently updated contact ids, then hydrate each via the public
      // contactView() API — CrmRepo has no bare "list all" method.
      const rows = deps.db.sqlite
        .prepare("SELECT id FROM contacts ORDER BY updated_at DESC, rowid DESC LIMIT ?")
        .all(limit) as { id: string }[];
      const contacts = rows.map((r) => deps.db.crm.contactView(r.id)!).filter(Boolean);
      return { contacts };
    });
  });

  app.post("/v1/admin/contacts", async (c) => {
    const parsed = CreateContactRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const { contact, created } = deps.db.crm.upsertContact(parsed.data);
      deps.bus.emit("contact.upserted", { contactId: contact.id, created });
      return { contact, created };
    });
  });

  app.post("/v1/admin/contacts/import", async (c) => {
    const parsed = ImportContactsRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const contacts = parsed.data.contacts.map((input) => deps.db.crm.upsertContact(input).contact);
      deps.bus.emit("contact.imported", { count: contacts.length });
      return { contacts };
    });
  });

  // -- Quota / audit -----------------------------------------------------

  app.get("/v1/admin/quota", (c) => guarded(c, () => deps.db.quota.latest()));

  app.get("/v1/admin/audit", (c) => {
    const agentId = c.req.query("agentId");
    const taskId = c.req.query("taskId");
    const kindParam = c.req.query("kind");
    const kind = kindParam ? (kindParam.split(",") as AuditKind[]) : undefined;
    const since = c.req.query("since");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    return guarded(c, () => ({ events: deps.db.audit.list({ agentId, taskId, kind, since, limit }) }));
  });

  // -- Live events (SSE) ------------------------------------------------

  app.get("/v1/admin/events", (c) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: BusEvent) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            // controller already closed; unsubscribe will follow via abort.
          }
        };
        controller.enqueue(encoder.encode(": connected\n\n"));
        const unsubscribe = deps.bus.subscribe(send);
        const close = () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        c.req.raw.signal.addEventListener("abort", close);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  // -- Inbound webhook (NOT admin-auth'd) ---------------------------------
  // Authenticated per-source by a shared secret (x-agyhq-webhook-secret),
  // compared with a timing-safe check; unknown source -> 404 (don't reveal
  // which sources are configured to an unauthenticated caller).

  app.post("/v1/inbound/webhook/:source", async (c) => {
    const source = c.req.param("source");
    const webhookCfg = deps.config.webhooks[source];
    if (!webhookCfg) return fail(c, "not_found", `unknown webhook source: ${source}`, 404);

    const providedSecret = c.req.header("x-agyhq-webhook-secret") ?? "";
    if (!providedSecret || !timingSafeEqualStr(providedSecret, webhookCfg.secret)) {
      return fail(c, "unauthorized", "invalid webhook secret", 401);
    }

    const parsed = WebhookLeadRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);

    return guarded(c, () => {
      const { event } = ingestWebhookLead({ db: deps.db, bus: deps.bus, config: deps.config }, source, parsed.data);
      return { event };
    });
  });

  return app;
}
