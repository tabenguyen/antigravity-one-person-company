// Shadow run admin routes — see the "Shadow run" block in admin-types.ts:
//   GET /v1/admin/shadow   GET /v1/admin/shadow/:id   POST /v1/admin/shadow   POST /v1/admin/shadow/:id/end

import type { Context, Hono } from "hono";
import type { ZodError } from "zod";
import type { ApiEnvelope, ApiErrorCode } from "@agyhq/core";
import { ConflictError, NotFoundError } from "@agyhq/db";
import type { AdminApiDeps } from "./admin-api.ts";
import { EndShadowRunRequestZ, StartShadowRunRequestZ, type ShadowOverview } from "./admin-types.ts";
import { computeShadowStatus, shadowCandidates, startShadowRun } from "./shadow.ts";
import { ValidationError } from "./util.ts";

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

export function registerShadowRoutes(app: Hono, deps: AdminApiDeps): void {
  const { db, bus } = deps;

  app.get("/v1/admin/shadow", (c) =>
    guarded(c, (): ShadowOverview => {
      const history = db.shadowRuns.list(20);
      const active = db.shadowRuns.getActive();
      const last = history.find((r) => r.endedAt !== null) ?? null;
      return {
        active: active ? computeShadowStatus(db, active) : null,
        last: last ? computeShadowStatus(db, last) : null,
        history,
        candidates: shadowCandidates(db),
      };
    }),
  );

  app.get("/v1/admin/shadow/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const run = db.shadowRuns.get(id);
      if (!run) throw new NotFoundError("shadow run", id);
      return { status: computeShadowStatus(db, run) };
    });
  });

  app.post("/v1/admin/shadow", async (c) => {
    const parsed = StartShadowRunRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const run = startShadowRun(db, parsed.data);
      db.audit.append({
        kind: "shadow.started",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { runId: run.id, plannedDays: run.plannedDays, agentIds: run.agentIds, notes: run.notes },
      });
      bus.emit("shadow.updated", { runId: run.id, started: true });
      return { status: computeShadowStatus(db, run) };
    });
  });

  app.post("/v1/admin/shadow/:id/end", async (c) => {
    const id = c.req.param("id");
    const parsed = EndShadowRunRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => {
      const run = db.shadowRuns.end(id, { notes: parsed.data.notes });
      const status = computeShadowStatus(db, run);
      db.audit.append({
        kind: "shadow.ended",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: {
          runId: run.id,
          day: status.day,
          plannedDays: run.plannedDays,
          totals: status.totals,
          verdicts: status.agents.map((a) => ({ agentId: a.agentId, verdict: a.verdict.status, reason: a.verdict.reason })),
        },
      });
      bus.emit("shadow.updated", { runId: run.id, ended: true });
      return { status };
    });
  });
}
