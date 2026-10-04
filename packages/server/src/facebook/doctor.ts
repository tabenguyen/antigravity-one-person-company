// `hq facebook doctor`: read-only preflight of the Facebook channel, to run BEFORE the first shadow run. Checks the token,
// the Page identity (`/me`), the five permissions and the app mode, and reports the safety facts (who could send what).
// Nothing is created, posted, hidden or scheduled. The token is never part of the report. With `kind: "fake"` it works
// offline (the fake provider answers from memory).

import { FACEBOOK_APP_SECRET_ENV } from "@agyhq/channels";
import { FB_REQUIRED_PERMISSIONS } from "@agyhq/core";
import type { FacebookPageProvider, FbInspection, TrustTier } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig, FacebookConfig } from "../config.ts";

export type FbDoctorStatus = "pass" | "warn" | "fail";

export interface FbDoctorCheck {
  id: string;
  status: FbDoctorStatus;
  title: string;
  detail: string;
}

export interface FacebookDoctorReport {
  generatedAt: string;
  mode: "daemon" | "local";
  /** No failing check. */
  ok: boolean;
  config: {
    kind: string;
    pageId: string | null;
    appId: string | null;
    apiVersion: string | null;
    tokenEnv: string | null;
    tokenPresent: boolean | null;
    /** The app secret env var (AGYHQ_FB_APP_SECRET) is set. Only whether, never the value. */
    appSecretPresent: boolean | null;
    declaredAppMode: string | null;
    pollIntervalMs: number;
    scheduleLeadHours: number;
  };
  checks: FbDoctorCheck[];
  inspection: FbInspection | null;
  safety: {
    outboundEnabled: boolean;
    defaultFanpageAgentId: string | null;
    agents: { id: string; trustTier: TrustTier; status: string }[];
    nothingCanBeSent: boolean;
    pendingDrafts: number;
  };
}

export interface FacebookDoctorOptions {
  mode?: "daemon" | "local";
  now?: () => Date;
  /** Why the provider could not be built (e.g. the token env var is not set); reported as the failing check. */
  providerError?: string | null;
  env?: NodeJS.ProcessEnv;
}

const check = (id: string, status: FbDoctorStatus, title: string, detail: string): FbDoctorCheck => ({ id, status, title, detail });

function configView(cfg: FacebookConfig, env: NodeJS.ProcessEnv): FacebookDoctorReport["config"] {
  const graph = cfg.kind === "graph" ? cfg : null;
  const tokenEnv = graph ? (graph.tokenEnv ?? "AGYHQ_FB_PAGE_TOKEN") : null;
  return {
    kind: cfg.kind,
    pageId: graph ? graph.pageId : cfg.kind === "fake" ? (cfg.pageId ?? "page-1") : null,
    appId: graph?.appId ?? null,
    apiVersion: graph ? graph.apiVersion : null,
    tokenEnv,
    tokenPresent: tokenEnv ? Boolean(env[tokenEnv]) : null,
    appSecretPresent: graph ? Boolean(env[FACEBOOK_APP_SECRET_ENV]) : null,
    declaredAppMode: graph?.appMode ?? null,
    pollIntervalMs: cfg.pollIntervalMs,
    scheduleLeadHours: cfg.scheduleLeadHours,
  };
}

export async function runFacebookDoctor(
  ctx: { config: Pick<AgyhqConfig, "facebook">; db: Db },
  provider: FacebookPageProvider | null,
  opts: FacebookDoctorOptions = {},
): Promise<FacebookDoctorReport> {
  const { db } = ctx;
  const cfg = ctx.config.facebook;
  const view = configView(cfg, opts.env ?? process.env);
  const checks: FbDoctorCheck[] = [];
  let inspection: FbInspection | null = null;

  // -- provider ---------------------------------------------------------------------------------------------------
  if (cfg.kind === "none") {
    checks.push(check("facebook.provider", "fail", "Facebook channel configured", 'facebook.kind is "none". Add a "facebook" block to agyhq.config.json (see agyhq.config.example.json).'));
  } else if (!provider) {
    checks.push(check("facebook.provider", "fail", "Facebook channel configured", opts.providerError ?? "the provider could not be built"));
  } else if (provider.kind === "fake") {
    checks.push(check("facebook.provider", "pass", "Facebook channel configured", "fake provider: runs entirely in memory, nothing talks to Facebook (offline mode)."));
  } else {
    checks.push(check("facebook.provider", "pass", "Facebook channel configured", `Graph API ${view.apiVersion}, Page ${view.pageId}, token from $${view.tokenEnv} (value not shown).`));
  }

  // -- token, page, permissions, app mode ------------------------------------------------------------------------------
  if (provider) {
    try {
      inspection = await provider.inspect();
    } catch (err) {
      checks.push(check("facebook.token", "fail", "Access token", `could not inspect the token: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  if (inspection) {
    checks.push(
      inspection.tokenValid
        ? check("facebook.token", "pass", "Access token", "the token is accepted by Facebook.")
        : check("facebook.token", "fail", "Access token", inspection.tokenError ?? "the token was rejected."),
    );

    if (inspection.tokenValid) {
      const page = inspection.page;
      if (!page) {
        checks.push(check("facebook.page", "fail", "Page identity", `the configured Page ${view.pageId ?? ""} cannot be read with this token. ${inspection.notes.join(" ")}`.trim()));
      } else if (view.pageId && page.id !== view.pageId) {
        checks.push(check("facebook.page", "fail", "Page identity", `the token resolves to Page "${page.name ?? "?"}" (${page.id}) but facebook.pageId is ${view.pageId}.`));
      } else {
        checks.push(check("facebook.page", "pass", "Page identity", `Page "${page.name ?? "?"}" (${page.id}).${inspection.notes.length ? ` ${inspection.notes.join(" ")}` : ""}`));
      }

      if (inspection.granted === null) {
        checks.push(
          check(
            "facebook.permissions",
            "warn",
            "Permissions",
            `this token type does not list its permissions, so they could not be verified. Check ${FB_REQUIRED_PERMISSIONS.join(", ")} in the Access Token Debugger (docs/FANPAGE.md "Pending spike" 6).`,
          ),
        );
      } else {
        for (const perm of FB_REQUIRED_PERMISSIONS) {
          const granted = inspection.granted.includes(perm);
          checks.push(
            check(
              `facebook.permission.${perm}`,
              granted ? "pass" : "fail",
              `Permission ${perm}`,
              granted ? "granted." : inspection.declined.includes(perm) ? "declined." : "not granted: add it to the app / the system user's assets and generate a new token.",
            ),
          );
        }
      }
    }
  }
  if (inspection && cfg.kind === "graph") {
    const proof = inspection.appSecretProof;
    checks.push(
      proof
        ? check("facebook.app_secret", "pass", "App secret proof", `$${FACEBOOK_APP_SECRET_ENV} is set: every Graph call carries appsecret_proof, so "Require App Secret" can be turned on in the app dashboard.`)
        : view.appSecretPresent
          ? check("facebook.app_secret", "warn", "App secret proof", `$${FACEBOOK_APP_SECRET_ENV} is set but this provider is not sending appsecret_proof (restart the daemon so it picks the variable up).`)
          : check(
              "facebook.app_secret",
              "warn",
              "App secret proof",
              `$${FACEBOOK_APP_SECRET_ENV} is not set: calls are not signed with appsecret_proof, so do NOT turn on "Require App Secret" in the app dashboard (every call would be rejected). Optional otherwise.`,
            ),
    );
  }
  const mode = inspection?.appMode ?? "unknown";
  if (provider) {
    checks.push(
      mode === "live"
        ? check("facebook.app_mode", "pass", "App mode", "Live.")
        : mode === "development"
          ? check("facebook.app_mode", "warn", "App mode", "Development: the app only sees data from people with a role on it (admins, developers, testers), so strangers' comments may not arrive. Fine for the sandbox Page; switch to Live (Standard Access needs no App Review) before the real Page.")
          : check("facebook.app_mode", "warn", "App mode", 'unknown: the Graph API does not report it. Set "facebook.appMode" ("development" or "live") in the config to record it.'),
    );
  }

  // -- harness safety ---------------------------------------------------------------------------------------------------
  const settings = db.settings.get();
  const fanpage = db.agents.list().filter((a) => a.role === "fanpage-manager" && a.status !== "archived");
  const def = settings.defaultFanpageAgentId;
  checks.push(
    fanpage.length === 0
      ? check("facebook.agent", "warn", "Fanpage Manager agent", "no fanpage-manager agent exists yet (create one on the Agents page, start in shadow tier).")
      : !def
        ? check("facebook.agent", "warn", "Fanpage Manager agent", `agent(s) ${fanpage.map((a) => a.id).join(", ")} exist, but no default Fanpage agent is set (Settings): new comments get no task until one is, or a comment_poll routine runs.`)
        : check("facebook.agent", "pass", "Fanpage Manager agent", `default: ${def}.`),
  );
  checks.push(
    cfg.scheduleLeadHours >= 24
      ? check("facebook.lead_time", "pass", "Scheduling lead time", `approved posts are scheduled at least ${cfg.scheduleLeadHours}h ahead, so a human can still cancel them in Meta Business Suite.`)
      : check("facebook.lead_time", "warn", "Scheduling lead time", `only ${cfg.scheduleLeadHours}h: a human has little time to cancel a scheduled post. 24h is the default.`),
  );
  const nothingCanBeSent = !settings.outboundEnabled || fanpage.every((a) => a.trustTier === "shadow");
  checks.push(
    nothingCanBeSent
      ? check("facebook.safety", "pass", "Nothing can reach Facebook yet", !settings.outboundEnabled ? "the kill switch is on (outbound disabled)." : "every fanpage agent is in the shadow tier: approving only records a verdict.")
      : check("facebook.safety", "warn", "Facebook can receive posts and replies", "outbound is enabled and a fanpage agent is past the shadow tier: approved items WILL be sent to Facebook (posts as scheduled posts)."),
  );

  return {
    generatedAt: (opts.now ? opts.now() : new Date()).toISOString(),
    mode: opts.mode ?? "daemon",
    ok: !checks.some((c) => c.status === "fail"),
    config: view,
    checks,
    inspection,
    safety: {
      outboundEnabled: settings.outboundEnabled,
      defaultFanpageAgentId: def,
      agents: fanpage.map((a) => ({ id: a.id, trustTier: a.trustTier, status: a.status })),
      nothingCanBeSent,
      pendingDrafts: db.outbox.list({ status: ["pending_approval"] }).filter((i) => i.channel !== "email").length,
    },
  };
}
