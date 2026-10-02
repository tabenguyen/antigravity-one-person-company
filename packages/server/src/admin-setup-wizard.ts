// Setup wizard routes — see the "Setup wizard" contract in admin-types.ts.
//
//   POST/GET /v1/admin/setup/generate, GET /:id, POST /:id/cancel   agy researches a domain (setup/jobs.ts)
//   GET/PUT  /v1/admin/setup/role-kb                                role knowledge base override (kbRoot/roles/<role>/)
//   GET/PUT  /v1/admin/setup/email, POST /v1/admin/setup/email/test mailbox settings, hot-swapped (setup/email-runtime.ts)
//   GET/PUT  /v1/admin/setup/sender                                 sender identity + unsubscribe address
//
// Nothing the generator produces is saved by these routes: the human applies it through PUT /setup/company and
// PUT /setup/role-kb after reviewing it.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { ApiEnvelope, ApiErrorCode } from "@agyhq/core";
import { ConflictError } from "@agyhq/db";
import type { ZodError } from "zod";
import type { AdminApiDeps } from "./admin-api.ts";
import {
  GenerateSetupRequestZ,
  PutRoleKbRequestZ,
  SenderSettingsInputZ,
  type RoleKbResponse,
} from "./admin-types.ts";
import { isKnownRole, roleKbSource, roleOverrideDir, syncKb } from "./kb-ingest.ts";
import { findPlaceholder } from "./readiness/placeholders.ts";
import { EmailRuntime } from "./setup/email-runtime.ts";
import {
  buildStored,
  buildView,
  inputToTestConfig,
  loadStoredEmail,
  parseEmailInput,
  saveStoredEmail,
  storedToConfig,
} from "./setup/email-settings.ts";
import { testEmailConfig, type EmailCheckers } from "./setup/email-test.ts";
import type { generateSetup } from "./setup/generator.ts";
import { SetupJobManager } from "./setup/jobs.ts";
import { SecretBox } from "./setup/secrets.ts";
import { effectiveSender, saveSender } from "./setup/sender-settings.ts";
import type { EmailConfig } from "./config.ts";
import type { EmailProvider } from "@agyhq/core";

/** Test seams (never set in production). */
export interface SetupOverrides {
  emailCheckers?: EmailCheckers;
  /** How a provider is built from an effective email config (default: @agyhq/channels createEmailProvider). */
  createProvider?: (cfg: EmailConfig) => EmailProvider | null;
  generate?: typeof generateSetup;
  brainRoot?: string;
  dnsCheck?: boolean;
  researchTimeoutMs?: number;
  repairTimeoutMs?: number;
  secretBox?: SecretBox;
  env?: NodeJS.ProcessEnv;
}

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

/** Fills in the long-lived wizard collaborators (email runtime, job manager) when the caller did not supply them. */
export function withSetupDefaults(deps: AdminApiDeps): AdminApiDeps {
  const o = deps.setupOverrides ?? {};
  const next: AdminApiDeps = { ...deps };
  if (!next.emailRuntime) {
    next.emailRuntime = new EmailRuntime({
      config: deps.config,
      db: deps.db,
      bus: deps.bus,
      box: o.secretBox ?? new SecretBox(deps.config.dataDir),
      provider: deps.emailProvider ?? null,
      createProvider: o.createProvider,
      env: o.env,
    });
  }
  if (!next.setupJobs) {
    next.setupJobs = new SetupJobManager({
      config: deps.config,
      db: deps.db,
      bus: deps.bus,
      generate: o.generate,
      brainRoot: o.brainRoot,
      dnsCheck: o.dnsCheck,
      timeoutMs: o.researchTimeoutMs,
      repairTimeoutMs: o.repairTimeoutMs,
    });
  }
  return next;
}

function titleOf(body: string, fallback: string): string {
  return body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

export function registerSetupWizardRoutes(app: Hono, deps: AdminApiDeps): void {
  const { config, db, bus } = deps;
  const runtime = deps.emailRuntime;
  const jobs = deps.setupJobs;
  if (!runtime || !jobs) throw new Error("registerSetupWizardRoutes: call withSetupDefaults(deps) first");
  const overrides = deps.setupOverrides ?? {};

  // -- 1. generate company profile + role KB from a domain ---------------------------------------

  app.post("/v1/admin/setup/generate", async (c) => {
    const parsed = GenerateSetupRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    try {
      return ok(c, { job: jobs.start(parsed.data) });
    } catch (err) {
      if (err instanceof ConflictError) return fail(c, "conflict", err.message, 409);
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  app.get("/v1/admin/setup/generate", (c) => ok(c, { jobs: jobs.list() }));

  app.get("/v1/admin/setup/generate/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    return job ? ok(c, { job }) : fail(c, "not_found", `setup job not found: ${c.req.param("id")}`, 404);
  });

  app.post("/v1/admin/setup/generate/:id/cancel", (c) => {
    const job = jobs.cancel(c.req.param("id"));
    return job ? ok(c, { job }) : fail(c, "not_found", `setup job not found: ${c.req.param("id")}`, 404);
  });

  // -- 2. role knowledge base ---------------------------------------------------------------------

  function roleKbView(role: string): Extract<RoleKbResponse, { ok: true }>["data"] {
    const src = roleKbSource(config, role);
    const files = src.files.map((abs) => {
      const body = fs.readFileSync(abs, "utf8");
      const relPath = path.basename(abs);
      return {
        relPath,
        title: titleOf(body, relPath.replace(/\.md$/, "")),
        body,
        // {{companyName}} is substituted at ingest, so judge the text the agent would actually see.
        hasPlaceholders: findPlaceholder(body.replaceAll("{{companyName}}", config.companyName)) !== null,
      };
    });
    return { role, source: src.source, files };
  }

  app.get("/v1/admin/setup/role-kb", (c) => {
    const role = c.req.query("role") ?? "sales-sdr";
    if (!isKnownRole(role)) return fail(c, "invalid_request", `unknown role "${role}"`, 400);
    try {
      return ok(c, roleKbView(role));
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  app.put("/v1/admin/setup/role-kb", async (c) => {
    const parsed = PutRoleKbRequestZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    const { role, files } = parsed.data;

    const seen = new Set<string>();
    for (const f of files) {
      const key = f.relPath.toLowerCase();
      if (seen.has(key)) return fail(c, "invalid_request", `duplicate file "${f.relPath}"`, 400);
      seen.add(key);
    }

    try {
      const dir = path.resolve(roleOverrideDir(config, role));
      fs.mkdirSync(dir, { recursive: true });
      const target = (rel: string) => {
        const p = path.resolve(dir, rel);
        if (path.dirname(p) !== dir) throw new Error(`relPath "${rel}" escapes the role directory`); // defence in depth over the zod regex
        return p;
      };

      // Write every new file next to its destination first, then rename into place, then drop stale .md files:
      // a failure while writing leaves the previous knowledge base untouched.
      const staged: { tmp: string; dest: string }[] = [];
      try {
        for (const f of files) {
          const dest = target(f.relPath);
          const tmp = `${dest}.${randomBytes(4).toString("hex")}.tmp`;
          fs.writeFileSync(tmp, f.body.endsWith("\n") ? f.body : `${f.body}\n`, "utf8");
          staged.push({ tmp, dest });
        }
      } catch (err) {
        for (const s of staged) fs.rmSync(s.tmp, { force: true });
        throw err;
      }
      for (const s of staged) fs.renameSync(s.tmp, s.dest);
      const keep = new Set(files.map((f) => f.relPath.toLowerCase()));
      const removed: string[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().endsWith(".md") && !keep.has(name.toLowerCase())) {
          fs.rmSync(path.join(dir, name), { force: true });
          removed.push(name);
        }
      }

      const summary = syncKb({ config, db });
      bus.emit("kb.synced", { scanned: summary.scanned, changed: summary.changed, deleted: summary.deleted });
      db.audit.append({
        kind: "kb.edited",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { scope: `role:${role}`, via: "setup.role-kb", files: files.map((f) => f.relPath), removed },
      });
      bus.emit("kb.edited", { scope: `role:${role}` });
      return ok(c, roleKbView(role));
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  // -- 3. email connection --------------------------------------------------------------------------

  const emailView = () => buildView({ config: runtime.current, source: runtime.source, stored: null }, runtime.passwordEnv);

  app.get("/v1/admin/setup/email", (c) => ok(c, { email: emailView() }));

  app.put("/v1/admin/setup/email", async (c) => {
    const parsed = parseEmailInput(await c.req.json().catch(() => null));
    if (!parsed.ok) return fail(c, "invalid_request", parsed.message, 400);
    try {
      const prev = loadStoredEmail(db);
      const stored = buildStored(parsed.data, prev, runtime.box, runtime.fileEmail.pollIntervalMs);
      const cfg = storedToConfig(stored, runtime.fileEmail, runtime.box, runtime.passwordEnv);
      if (cfg.kind === "imap-smtp") {
        const missing: string[] = [];
        if (!cfg.imap.pass) missing.push("IMAP password is required (none stored, or the stored one cannot be decrypted)");
        if (!cfg.smtp.pass) missing.push("SMTP password is required (none stored, or the stored one cannot be decrypted)");
        if (missing.length > 0) return fail(c, "invalid_request", missing.join("; "), 400);
      }
      // Swap first (a provider that cannot be built is rejected with the old mailbox still running), then persist.
      await runtime.apply(cfg, "ui");
      saveStoredEmail(db, stored);
      db.audit.append({
        kind: "settings.changed",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { area: "email", kind: cfg.kind, address: "address" in cfg ? cfg.address : null }, // never the passwords
      });
      bus.emit("settings.changed", { area: "email" });
      return ok(c, { email: emailView() });
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  app.post("/v1/admin/setup/email/test", async (c) => {
    const parsed = parseEmailInput(await c.req.json().catch(() => null));
    if (!parsed.ok) return fail(c, "invalid_request", parsed.message, 400);
    try {
      const cfg = inputToTestConfig(parsed.data, loadStoredEmail(db), runtime.fileEmail, runtime.box, runtime.passwordEnv);
      const outcome = await testEmailConfig(cfg, overrides.emailCheckers);
      return ok(c, outcome);
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });

  // -- 4. sender identity & unsubscribe -------------------------------------------------------------

  app.get("/v1/admin/setup/sender", (c) => ok(c, { sender: effectiveSender(config, db) }));

  app.put("/v1/admin/setup/sender", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const cleaned: Record<string, unknown> = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) cleaned[k] = typeof v === "string" ? v.trim() : v;
      if (typeof cleaned["unsubscribeMailto"] === "string") cleaned["unsubscribeMailto"] = (cleaned["unsubscribeMailto"] as string).replace(/^mailto:/i, "");
    }
    const parsed = SenderSettingsInputZ.safeParse(cleaned);
    if (!parsed.success) return fail(c, "invalid_request", zodMessage(parsed.error), 400);
    try {
      saveSender(db, parsed.data);
      db.audit.append({
        kind: "settings.changed",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { area: "sender", address: parsed.data.address, unsubscribeMailto: parsed.data.unsubscribeMailto },
      });
      bus.emit("settings.changed", { area: "sender" });
      bus.emit("status.changed", { sender: true });
      return ok(c, { sender: effectiveSender(config, db) });
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });
}
