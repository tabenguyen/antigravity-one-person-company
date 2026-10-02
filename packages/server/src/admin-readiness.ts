// Phase 3 admin routes — see the "Phase 3 additions" contract in admin-types.ts.
//
//   GET  /v1/admin/readiness
//   GET  /v1/admin/setup/company
//   PUT  /v1/admin/setup/company
//   POST /v1/admin/setup/email-test
//   POST /v1/admin/killswitch          (supersedes the Phase 2 handler: enabling is readiness-gated)
//   PATCH /v1/admin/settings           (middleware only: refuses outboundEnabled:true when not ready)
//
// Registered before the Phase 2 routes in createAdminApi, so these win.

import type { Context, Hono } from "hono";
import type { ApiEnvelope, ApiErrorCode, CompanyProfile, EmailProvider } from "@agyhq/core";
import type { ZodError } from "zod";
import type { AdminApiDeps } from "./admin-api.ts";
import { CompanyProfileInputZ, KillSwitchForceRequestZ } from "./admin-types.ts";
import { rerenderAll } from "./provision.ts";
import { syncKb } from "./kb-ingest.ts";
import { computeReadiness, failingChecks, type VerifyResult } from "./readiness/checks.ts";
import { writeAcknowledged } from "./readiness/monitor.ts";
import { loadCompanyProfile, saveCompanyProfile, writeCompanyKb } from "./readiness/company.ts";
import { placeholderMarkers } from "./readiness/placeholders.ts";

const VERIFY_TTL_MS = 15_000;

function ok<T>(c: Context, data: T) {
  const body: ApiEnvelope<T> = { ok: true, data };
  return c.json(body, 200);
}

function fail(c: Context, code: ApiErrorCode, message: string, status: 400 | 409 | 500) {
  const body: ApiEnvelope<never> = { ok: false, error: { code, message } };
  return c.json(body, status);
}

function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Wraps the provider's verify() with a short-TTL cache; `fresh` bypasses (and refreshes) it. `provider` may be a getter
 * (EmailRuntime) so a hot-swapped mailbox is probed — the cache is dropped whenever the provider instance changes.
 */
export function createVerifier(provider: EmailProvider | null | (() => EmailProvider | null), ttlMs = VERIFY_TTL_MS) {
  let cache: { result: VerifyResult; at: number; provider: EmailProvider } | null = null;
  return async function verify(opts: { fresh?: boolean } = {}): Promise<VerifyResult> {
    const current = typeof provider === "function" ? provider() : provider;
    if (!current) return { ok: false, error: "no email provider configured" };
    const now = Date.now();
    if (!opts.fresh && cache && cache.provider === current && now - cache.at < ttlMs) return cache.result;
    let result: VerifyResult;
    try {
      result = await current.verify();
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    cache = { result, at: now, provider: current };
    return result;
  };
}

/** Trim string values so " " padding never defeats min-length validation. */
function trimStrings(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v.trim();
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? x.trim() : x));
    else out[k] = v;
  }
  // A blank optional URL means "not set".
  for (const key of ["website", "meetingLink"]) if (out[key] === "") out[key] = null;
  return out;
}

export function registerReadinessRoutes(app: Hono, deps: AdminApiDeps): void {
  const verify = createVerifier(() => (deps.emailRuntime ? deps.emailRuntime.provider : (deps.emailProvider ?? null)));

  // If a company profile was saved, its name wins over config.companyName for
  // {{companyName}} substitution in role KB and workspace templates. The config
  // object is shared by reference with kb-ingest and provision, so updating it
  // here (at registration, which runs before the daemon's startup rerender/sync,
  // and again on every profile save) is the whole change.
  const existing = loadCompanyProfile(deps.db);
  if (existing && existing.companyName && existing.companyName !== deps.config.companyName) {
    deps.config.companyName = existing.companyName;
  }

  const readinessDeps = (fresh: boolean) => ({
    config: deps.config,
    db: deps.db,
    verifyEmail: () => verify({ fresh }),
  });

  async function gate(force: boolean): Promise<{ allowed: true; forcedFailing: string[] } | { allowed: false; message: string }> {
    const report = await computeReadiness(readinessDeps(true));
    const failing = failingChecks(report);
    if (failing.length === 0) return { allowed: true, forcedFailing: [] };
    if (force) return { allowed: true, forcedFailing: failing.map((f) => f.id) };
    return {
      allowed: false,
      message: `Not ready to enable outbound — ${failing.length} check(s) failing: ${failing.map((f) => f.title).join("; ")}. Fix them on the Setup page, or retry with force:true to override.`,
    };
  }

  // -- readiness ---------------------------------------------------------------

  app.get("/v1/admin/readiness", async (c) => {
    try {
      return ok(c, { readiness: await computeReadiness(readinessDeps(false)) });
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  // -- company profile -----------------------------------------------------------

  app.get("/v1/admin/setup/company", (c) => ok(c, { profile: loadCompanyProfile(deps.db) }));

  app.put("/v1/admin/setup/company", async (c) => {
    const parsed = CompanyProfileInputZ.safeParse(trimStrings(await c.req.json().catch(() => null)));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);

    const placeholderProblems: string[] = [];
    for (const [field, value] of Object.entries(parsed.data)) {
      if (typeof value !== "string") continue;
      const markers = placeholderMarkers(value);
      if (markers.length > 0) {
        placeholderProblems.push(`${field}: still contains placeholder text (${markers.join(", ")}) — replace it with real content`);
      }
    }
    if (placeholderProblems.length > 0) return fail(c, "invalid_request", placeholderProblems.join("; "), 400);

    try {
      const previousName = deps.config.companyName;
      const profile: CompanyProfile = { ...parsed.data, updatedAt: new Date().toISOString() };
      saveCompanyProfile(deps.db, profile);
      const files = writeCompanyKb(deps.config, profile);

      // Role KB / workspace templates substitute {{companyName}} from config.
      const nameChanged = profile.companyName !== previousName;
      deps.config.companyName = profile.companyName;

      const summary = syncKb({ config: deps.config, db: deps.db });
      deps.bus.emit("kb.synced", { scanned: summary.scanned, changed: summary.changed, deleted: summary.deleted });

      if (nameChanged) {
        try {
          const results = rerenderAll({ config: deps.config, db: deps.db });
          if (results.some((r) => r.ok)) deps.onRerender?.();
        } catch {
          // Non-fatal: the profile and KB are saved; the next daemon start re-renders workspaces.
        }
      }

      deps.db.audit.append({
        kind: "setup.company_saved",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { companyName: profile.companyName, files },
      });
      deps.bus.emit("setup.company_saved", { companyName: profile.companyName });
      return ok(c, { profile, files });
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  // -- email connection test -------------------------------------------------------

  app.post("/v1/admin/setup/email-test", async (c) => {
    const result = await verify({ fresh: true });
    return ok(c, { ok: result.ok, error: result.ok ? null : result.error, checkedAt: new Date().toISOString() });
  });

  // -- kill switch (readiness-gated) --------------------------------------------------

  app.post("/v1/admin/killswitch", async (c) => {
    const parsed = KillSwitchForceRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    const { outboundEnabled, reason, force } = parsed.data;

    try {
      let forcedFailing: string[] = [];
      if (outboundEnabled) {
        const decision = await gate(force === true);
        if (!decision.allowed) return fail(c, "conflict", decision.message, 409);
        forcedFailing = decision.forcedFailing;
      }

      const settings = deps.db.settings.patch({
        outboundEnabled,
        outboundDisabledReason: outboundEnabled ? null : (reason ?? "disabled via killswitch"),
      });
      // The readiness monitor auto-pauses on failing checks, except the ones a human just forced past.
      writeAcknowledged(deps.db, outboundEnabled ? forcedFailing : []);
      if (forcedFailing.length > 0) {
        deps.db.audit.append({
          kind: "killswitch.forced",
          agentId: null,
          taskId: null,
          conversationId: null,
          data: { failing: forcedFailing, reason: reason ?? null },
        });
      }
      deps.db.audit.append({
        kind: "settings.changed",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { outboundEnabled: settings.outboundEnabled, reason: settings.outboundDisabledReason },
      });
      deps.bus.emit("settings.changed", { outboundEnabled: settings.outboundEnabled });
      deps.bus.emit("status.changed", { outboundEnabled: settings.outboundEnabled });
      return ok(c, { settings });
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  // PATCH /settings accepts outboundEnabled too; without this a half-configured
  // system could be switched on around the kill-switch gate. (Settings PATCH is
  // strict, so there is no force flag here — use POST /killswitch for that.)
  app.use("/v1/admin/settings", async (c, next) => {
    if (c.req.method !== "PATCH") return next();
    const body = (await c.req.json().catch(() => null)) as { outboundEnabled?: unknown } | null;
    if (body?.outboundEnabled === true && !deps.db.settings.get().outboundEnabled) {
      const decision = await gate(false);
      if (!decision.allowed) return fail(c, "conflict", decision.message, 409);
    }
    return next();
  });
}
