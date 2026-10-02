// Phase 3 admin routes — see the "Phase 3 additions" contract in admin-types.ts:
// reject-with-category, relint, scorecards, promotion criteria, agent promotion.
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ApiEnvelope, ApiErrorCode, PromotionCriteria } from "@agyhq/core";
import { ConflictError, NotFoundError, OutboxTransitionError } from "@agyhq/db";
import type { AdminApiDeps } from "./admin-api.ts";
import { PromoteAgentRequestZ, RejectOutboxWithCategoryRequestZ } from "./admin-types.ts";
import { computeScorecard, loadCriteria, lintOutboxItem, saveCriteria } from "./quality/index.ts";

const DEFAULT_DAYS = 14;

function ok<T>(c: Context, data: T) {
  const body: ApiEnvelope<T> = { ok: true, data };
  return c.json(body, 200);
}

function fail(c: Context, code: ApiErrorCode, message: string, status: 400 | 404 | 409 | 500) {
  const body: ApiEnvelope<never> = { ok: false, error: { code, message } };
  return c.json(body, status);
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

async function guarded(c: Context, fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return ok(c, (await fn()) as object);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(c, "not_found", err.message, 404);
    if (err instanceof OutboxTransitionError || err instanceof ConflictError) return fail(c, "conflict", err.message, 409);
    if (err instanceof HttpConflict) return fail(c, "conflict", err.message, 409);
    return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
  }
}

class HttpConflict extends Error {}

const PromotionCriteriaPatchZ = z
  .object({
    minDecided: z.number().int().min(0).max(100_000),
    minApprovalRate: z.number().min(0).max(1),
    maxMedianEditRatio: z.number().min(0).max(1),
    maxComplianceRejections: z.number().int().min(0).max(100_000),
    maxLintErrorsRate: z.number().min(0).max(1),
  })
  .partial()
  .strict() satisfies z.ZodType<Partial<PromotionCriteria>>;

function parseDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
}

export function registerQualityRoutes(app: Hono, deps: AdminApiDeps): void {
  const { db, bus } = deps;

  // Supersedes the Phase 2 reject route (removed from admin-api.ts): same behaviour
  // (status, decisionNote, accepted agent memory) plus a structured category.
  app.post("/v1/admin/outbox/:id/reject", async (c) => {
    const id = c.req.param("id");
    const parsed = RejectOutboxWithCategoryRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const existing = db.outbox.get(id);
      if (!existing) throw new NotFoundError("outbox item", id);
      const category = parsed.data.category ?? "other";
      const decidedBy = parsed.data.reviewer ? `human:${parsed.data.reviewer}` : "human:admin";
      const item = db.outbox.decide(id, "rejected", {
        decidedBy,
        decisionNote: parsed.data.reason,
        decidedAt: new Date().toISOString(),
        rejectionCategory: category,
      });
      const subject = item.threadKey ?? `outbox:${item.id}`;
      const memory = db.memory.propose(
        item.agentId,
        `Human rejected your draft to ${item.to} (${category}): ${parsed.data.reason}`,
        subject,
      );
      db.memory.setStatus(memory.id, "accepted");
      db.audit.append({
        kind: "outbox.rejected",
        agentId: item.agentId,
        taskId: item.taskId,
        conversationId: null,
        data: { id: item.id, reason: parsed.data.reason, category, memoryId: memory.id },
      });
      bus.emit("outbox.updated", { outboxId: id, status: "rejected" });
      return { item };
    });
  });

  app.post("/v1/admin/outbox/:id/relint", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const existing = db.outbox.get(id);
      if (!existing) throw new NotFoundError("outbox item", id);
      const item = db.outbox.setLint(id, lintOutboxItem(db, existing));
      bus.emit("outbox.updated", { outboxId: id, status: item.status, relinted: true });
      return { item };
    });
  });

  app.get("/v1/admin/scorecards", (c) => {
    const days = parseDays(c.req.query("days"));
    if (days === null) return fail(c, "invalid_request", "days must be an integer between 1 and 365", 400);
    const agentId = c.req.query("agentId");
    return guarded(c, () => {
      const criteria = loadCriteria(db);
      const agents = db.agents.list().filter((a) => a.status !== "archived" && (!agentId || a.id === agentId));
      if (agentId && agents.length === 0) throw new NotFoundError("agent", agentId);
      return { days, criteria, scorecards: agents.map((a) => computeScorecard(db, a, days, criteria)) };
    });
  });

  app.get("/v1/admin/promotion-criteria", (c) => guarded(c, () => ({ criteria: loadCriteria(db) })));

  app.put("/v1/admin/promotion-criteria", async (c) => {
    const parsed = PromotionCriteriaPatchZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const criteria = saveCriteria(db, parsed.data);
      db.audit.append({ kind: "settings.changed", agentId: null, taskId: null, conversationId: null, data: { promotionCriteria: criteria } });
      bus.emit("settings.changed", { promotionCriteria: criteria });
      return { criteria };
    });
  });

  app.post("/v1/admin/agents/:id/promote", async (c) => {
    const id = c.req.param("id");
    const parsed = PromoteAgentRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    const days = parseDays(c.req.query("days"));
    if (days === null) return fail(c, "invalid_request", "days must be an integer between 1 and 365", 400);
    return guarded(c, () => {
      const agent = db.agents.get(id);
      if (!agent) throw new NotFoundError("agent", id);
      const scorecard = computeScorecard(db, agent, days, loadCriteria(db));
      const promotion = scorecard.promotion;
      if (!promotion) throw new HttpConflict(`agent "${id}" is already at the highest trust tier (${agent.trustTier})`);
      const force = parsed.data.force === true;
      if (!promotion.eligible && !force) {
        throw new HttpConflict(
          `agent "${id}" is not eligible for ${promotion.nextTier} (last ${days} days): ${promotion.unmet.join("; ")}. Pass force to override.`,
        );
      }
      const updated = db.agents.update(id, { trustTier: promotion.nextTier });
      db.audit.append({
        kind: "agent.promoted",
        agentId: id,
        taskId: null,
        conversationId: null,
        data: {
          from: agent.trustTier,
          to: promotion.nextTier,
          forced: force && !promotion.eligible,
          note: parsed.data.note ?? null,
          unmet: promotion.unmet,
          windowDays: days,
          decided: scorecard.decided,
          approvalRate: scorecard.approvalRate,
          medianEditRatio: scorecard.medianEditRatio,
          lintErrorRate: scorecard.lintErrorRate,
        },
      });
      bus.emit("agent.updated", { agentId: id, patch: { trustTier: promotion.nextTier }, promoted: true });
      return { agent: updated };
    });
  });
}
