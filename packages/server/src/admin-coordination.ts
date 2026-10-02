// Phase 4 admin routes (docs/PHASE4.md) — see the "Phase 4 additions" contract in admin-types.ts:
//   POST /v1/admin/contacts/:id/handoff   GET /v1/admin/kpis   GET /v1/admin/briefings[/:id]

import type { Context, Hono } from "hono";
import type { ZodError } from "zod";
import type { ApiEnvelope, ApiErrorCode } from "@agyhq/core";
import { ConflictError, NotFoundError } from "@agyhq/db";
import type { AdminApiDeps } from "./admin-api.ts";
import { HandoffContactRequestZ } from "./admin-types.ts";
import { handoffContact } from "./handoff.ts";
import { computeKpis } from "./kpis.ts";
import { roleRouting, roleTaskKinds } from "./routing.ts";
import { ValidationError } from "./util.ts";

const DEFAULT_KPI_DAYS = 7;

function ok<T>(c: Context, data: T) {
  const body: ApiEnvelope<T> = { ok: true, data };
  return c.json(body, 200);
}

function fail(c: Context, code: ApiErrorCode, message: string, status: 400 | 404 | 409 | 500) {
  const body: ApiEnvelope<never> = { ok: false, error: { code, message } };
  return c.json(body, status);
}

function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

async function guarded(c: Context, fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return ok(c, (await fn()) as object);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(c, "not_found", err.message, 404);
    if (err instanceof ConflictError) return fail(c, "conflict", err.message, 409);
    if (err instanceof ValidationError) return fail(c, "invalid_request", err.message, 400);
    return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
  }
}

export function registerCoordinationRoutes(app: Hono, deps: AdminApiDeps): void {
  const { db, bus, config } = deps;

  app.post("/v1/admin/contacts/:id/handoff", async (c) => {
    const id = c.req.param("id");
    const parsed = HandoffContactRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () =>
      handoffContact(
        {
          db,
          emit: (type, data) => bus.emit(type, data),
          taskKindsFor: (agent) => roleTaskKinds(config, agent.role),
          followUpKindsFor: (agent) => roleRouting(config, agent?.role ?? "sales-sdr")?.followUpKinds ?? [config.routing.followUpKind],
        },
        { contactId: id, toRole: parsed.data.toRole, summary: parsed.data.summary, actor: { type: "human" } },
      ),
    );
  });

  app.get("/v1/admin/kpis", (c) => {
    const raw = c.req.query("days");
    const days = raw === undefined || raw === "" ? DEFAULT_KPI_DAYS : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 365) return fail(c, "invalid_request", "days must be an integer between 1 and 365", 400);
    return guarded(c, () => computeKpis(db, days));
  });

  app.get("/v1/admin/briefings", (c) => {
    const raw = c.req.query("limit");
    const limit = raw === undefined || raw === "" ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return fail(c, "invalid_request", "limit must be a positive integer", 400);
    const agentId = c.req.query("agentId") || undefined;
    return guarded(c, () => ({ briefings: db.briefings.list({ limit, agentId }) }));
  });

  app.get("/v1/admin/briefings/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const briefing = db.briefings.get(id);
      if (!briefing) throw new NotFoundError("briefing", id);
      return { briefing };
    });
  });
}
