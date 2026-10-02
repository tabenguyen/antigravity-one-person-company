// Phase 3 admin routes — see the "Phase 3 additions" contract in admin-types.ts:
//   GET/POST /v1/admin/routines, PATCH/DELETE /v1/admin/routines/:id, POST /v1/admin/routines/:id/run
//   GET/POST /v1/admin/evals, GET /v1/admin/evals/:id
//   GET /v1/admin/evals/suites   (extra: suites + their cases, for the UI/CLI start form)

import type { Context, Hono } from "hono";
import type { ApiEnvelope, ApiErrorCode, RoutineKind } from "@agyhq/core";
import { ConflictError, NotFoundError } from "@agyhq/db";
import { loadTemplate } from "@agyhq/workspace";
import type { ZodError } from "zod";
import type { AdminApiDeps } from "./admin-api.ts";
import { CreateRoutineRequestZ, PatchRoutineRequestZ, StartEvalRequestZ } from "./admin-types.ts";
import { ValidationError } from "./util.ts";
import { assertTimezone, CronError, parseCron } from "./routines/cron.ts";
import { parseRoutineConfig, ROUTINE_TASK_KIND } from "./routines/config.ts";
import { computeNextRunAt, runRoutine } from "./routines/run.ts";
import { listSuites, loadSuite } from "./evals/suite.ts";
import { startEvalRun } from "./evals/manager.ts";

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
    if (err instanceof ValidationError || err instanceof CronError) return fail(c, "invalid_request", err.message, 400);
    return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
  }
}

export function registerRoutinesRoutes(app: Hono, deps: AdminApiDeps): void {
  const { db, config, bus } = deps;

  /** Throws unless the (kind, config) pair is valid for this agent; returns the normalized config. */
  function validateRoutine(agentId: string, kind: RoutineKind, rawConfig: Record<string, unknown>): Record<string, unknown> {
    const agent = db.agents.get(agentId);
    if (!agent) throw new NotFoundError("agent", agentId);
    const cfg = parseRoutineConfig(kind, rawConfig);
    const needed = kind === "custom_task" ? String(cfg["kind"]) : ROUTINE_TASK_KIND[kind];
    if (needed) {
      let kinds: string[];
      try {
        kinds = loadTemplate(config.templatesRoot, agent.role).taskKinds.map((k) => k.kind);
      } catch (err) {
        throw new ValidationError(`cannot load template for role "${agent.role}": ${(err as Error).message}`);
      }
      if (!kinds.includes(needed)) {
        throw new ValidationError(`task kind "${needed}" is not defined by the ${agent.role} template; known kinds: ${kinds.join(", ")}`);
      }
    }
    return cfg;
  }

  function validateSchedule(schedule: string, timezone: string): void {
    parseCron(schedule);
    assertTimezone(timezone);
  }

  // -- Routines ----------------------------------------------------------------

  app.get("/v1/admin/routines", (c) => {
    const agentId = c.req.query("agentId") || undefined;
    return guarded(c, () => ({ routines: db.routines.list(agentId) }));
  });

  app.post("/v1/admin/routines", async (c) => {
    const parsed = CreateRoutineRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    const req = parsed.data;
    return guarded(c, () => {
      validateSchedule(req.schedule, req.timezone);
      const cfg = validateRoutine(req.agentId, req.kind, req.config);
      const routine = db.routines.create({
        agentId: req.agentId,
        kind: req.kind,
        name: req.name,
        schedule: req.schedule.trim().replace(/\s+/g, " "),
        timezone: req.timezone,
        config: cfg,
        enabled: req.enabled,
        nextRunAt: computeNextRunAt({ schedule: req.schedule, timezone: req.timezone, enabled: req.enabled }, new Date()),
      });
      bus.emit("routine.updated", { routineId: routine.id, agentId: routine.agentId });
      return { routine };
    });
  });

  app.patch("/v1/admin/routines/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = PatchRoutineRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    const patch = parsed.data;
    return guarded(c, () => {
      const existing = db.routines.get(id);
      if (!existing) throw new NotFoundError("routine", id);
      const schedule = patch.schedule ? patch.schedule.trim().replace(/\s+/g, " ") : existing.schedule;
      const timezone = patch.timezone ?? existing.timezone;
      const kind = patch.kind ?? existing.kind;
      const enabled = patch.enabled ?? existing.enabled;
      validateSchedule(schedule, timezone);
      const configChanged = patch.config !== undefined || patch.kind !== undefined;
      const config = configChanged ? validateRoutine(existing.agentId, kind, patch.config ?? (patch.kind !== undefined ? {} : existing.config)) : existing.config;

      const timingChanged = schedule !== existing.schedule || timezone !== existing.timezone || enabled !== existing.enabled;
      const routine = db.routines.update(id, {
        kind,
        name: patch.name,
        schedule,
        timezone,
        config,
        enabled,
        ...(timingChanged ? { nextRunAt: computeNextRunAt({ schedule, timezone, enabled }, new Date()) } : {}),
      });
      bus.emit("routine.updated", { routineId: id, agentId: routine.agentId });
      return { routine };
    });
  });

  app.delete("/v1/admin/routines/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const existing = db.routines.get(id);
      if (!existing) throw new NotFoundError("routine", id);
      db.routines.delete(id);
      bus.emit("routine.updated", { routineId: id, agentId: existing.agentId, deleted: true });
      return { deleted: true as const };
    });
  });

  app.post("/v1/admin/routines/:id/run", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const existing = db.routines.get(id);
      if (!existing) throw new NotFoundError("routine", id);
      runRoutine({ db, bus }, existing, { manual: true });
      return { routine: db.routines.get(id)! };
    });
  });

  // -- Evals ---------------------------------------------------------------------

  app.get("/v1/admin/evals/suites", (c) =>
    guarded(c, () => {
      const suites = listSuites(config.templatesRoot).map((name) => {
        const loaded = loadSuite(config.templatesRoot, name);
        let defaultModel: string | null = null;
        try {
          defaultModel = loadTemplate(config.templatesRoot, name).defaultModel;
        } catch {
          // suite without a loadable template: still list it
        }
        return { name, defaultModel, cases: loaded.cases.map((k) => ({ id: k.id, description: k.description, kind: k.kind })) };
      });
      return { suites };
    }),
  );

  app.get("/v1/admin/evals", (c) => {
    const suite = c.req.query("suite") || undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return guarded(c, () => ({ runs: db.evalRuns.list({ suite, limit: Number.isFinite(limit) ? limit : undefined }) }));
  });

  app.get("/v1/admin/evals/:id", (c) => {
    const id = c.req.param("id");
    return guarded(c, () => {
      const run = db.evalRuns.get(id);
      if (!run) throw new NotFoundError("eval run", id);
      return { run };
    });
  });

  app.post("/v1/admin/evals", async (c) => {
    const parsed = StartEvalRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    return guarded(c, () => ({ run: startEvalRun({ config, db, bus }, parsed.data) }));
  });
}
