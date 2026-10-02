// POST /v1/admin/email/doctor — the same read-only mailbox preflight as `hq email doctor`, against the SAVED email
// settings (UI wizard or config file), for the setup wizard / readiness page.
//
//   body: { sample?: 0..50, sendTest?: "<address>" }   -> EmailDoctorResponse
//
// Nothing is created, marked, moved or sent. `sendTest` is the only thing that sends, exactly one email, and only when
// the caller names an address. Takes up to ~1 minute against a slow server (per-step timeouts of 20s).

import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ApiEnvelope, ApiErrorCode } from "@agyhq/core";
import type { AdminApiDeps } from "./admin-api.ts";
import { runEmailDoctor, type EmailDoctorReport } from "./email-doctor.ts";

export const EmailDoctorRequestZ = z
  .object({
    sample: z.number().int().min(0).max(50).default(10),
    sendTest: z.string().trim().email().max(320).optional(),
  })
  .strict();
export type EmailDoctorRequest = z.input<typeof EmailDoctorRequestZ>;
export type EmailDoctorResponse = ApiEnvelope<{ report: EmailDoctorReport }>;

function fail(c: Context, code: ApiErrorCode, message: string, status: 400 | 500) {
  const body: ApiEnvelope<never> = { ok: false, error: { code, message } };
  return c.json(body, status);
}

export function registerEmailDoctorRoutes(app: Hono, deps: AdminApiDeps): void {
  app.post("/v1/admin/email/doctor", async (c) => {
    const parsed = EmailDoctorRequestZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return fail(c, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "), 400);
    }
    try {
      const email = deps.emailRuntime ? deps.emailRuntime.current : deps.config.email;
      const report = await runEmailDoctor({ config: deps.config, db: deps.db }, email, {
        sample: parsed.data.sample,
        sendTest: parsed.data.sendTest ?? null,
        mode: "daemon",
      });
      const body: EmailDoctorResponse = { ok: true, data: { report } };
      return c.json(body, 200);
    } catch (err) {
      return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
    }
  });
}
