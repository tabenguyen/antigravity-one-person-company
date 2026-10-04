import { describe, it, expect } from "vitest";
import { readAcknowledged } from "../src/readiness/monitor.ts";
import fs from "node:fs";
import path from "node:path";
import { FakeEmailProvider } from "@agyhq/channels";
import type { CompanyProfile, ReadinessReport } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { EventBus } from "../src/event-bus.ts";
import type { AgyhqConfig } from "../src/config.ts";
import { findPlaceholder } from "../src/readiness/placeholders.ts";
import { makeTempDataDir, makeTestConfig, openTestDb, REPO_ROOT } from "./helpers.ts";

const VALID_PROFILE = {
  companyName: "Acme Logistics",
  website: "https://acme.io",
  oneLiner: "Inventory sync for multi-channel sellers.",
  productDescription: "Acme keeps stock levels in sync across Shopee, Lazada and your own store in real time.",
  targetCustomers: "Vietnamese e-commerce retailers selling on two or more channels.",
  painPoints: "- Overselling when stock runs out on one channel\n- Manual end-of-day reconciliation",
  differentiators: "Setup in one afternoon, Vietnamese support.",
  pricingPolicy: "Never quote prices. Say plans start with a free pilot and offer a call.",
  proofPoints: "Used by 40 shops in Ho Chi Minh City.",
  forbiddenClaims: "- Never promise zero overselling\n- Never mention competitors by name",
  meetingLink: "https://cal.acme.io/mai",
  languages: ["vi", "en"],
};

type Env = ReturnType<typeof build>;

function build(opts: { config?: Partial<AgyhqConfig>; useRepoTemplates?: boolean } = {}) {
  const dataDir = makeTempDataDir();
  const emptyTemplates = path.join(dataDir, "templates");
  fs.mkdirSync(emptyTemplates, { recursive: true });
  const config = makeTestConfig({
    dataDir,
    kbRoot: path.join(dataDir, "kb"),
    templatesRoot: opts.useRepoTemplates ? path.join(REPO_ROOT, "templates") : emptyTemplates,
    email: { kind: "imap-smtp", pollIntervalMs: 60_000 } as AgyhqConfig["email"],
    sender: { name: "Acme Sales", address: "mai@acme.io", companyAddressLine: "Acme Ltd, 1 Nguyen Hue, HCMC" },
    unsubscribeMailto: "unsubscribe@acme.io",
    ...opts.config,
  });
  const db = openTestDb();
  const bus = new EventBus();
  const provider = new FakeEmailProvider();
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.type));
  const app = createAdminApi({ config, db, bus, emailProvider: provider });
  const headers = { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, config, db, provider, events, call };
}

function makeReady(env: Env) {
  env.db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] }, trustTier: "shadow" });
  env.db.settings.patch({ defaultSdrAgentId: "sdr-01" });
}

describe("GET /v1/admin/readiness", () => {
  it("requires auth and reports failing checks on a fresh system", async () => {
    const env = build();
    const unauth = await env.app.request("/v1/admin/readiness");
    expect(unauth.status).toBe(401);
    const { status, body } = await env.call("GET", "/v1/admin/readiness");
    expect(status).toBe(200);
    const r = body.data.readiness as ReadinessReport;
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.id === "company.profile")?.status).toBe("fail");
  });
});

describe("company profile routes", () => {
  it("GET returns null before any save", async () => {
    const env = build();
    const { body } = await env.call("GET", "/v1/admin/setup/company");
    expect(body.data.profile).toBeNull();
  });

  it("PUT validates input", async () => {
    const env = build();
    const bad = await env.call("PUT", "/v1/admin/setup/company", { ...VALID_PROFILE, oneLiner: "short", website: "not a url" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
    expect(bad.body.error.message).toContain("oneLiner");
    expect(bad.body.error.message).toContain("website");
    expect(env.db.kv.get("company_profile")).toBeNull();

    const missing = await env.call("PUT", "/v1/admin/setup/company", {});
    expect(missing.status).toBe(400);
    const notJson = await env.app.request("/v1/admin/setup/company", { method: "PUT", headers: { authorization: `Bearer ${env.config.adminToken}` }, body: "nope" });
    expect(notJson.status).toBe(400);
  });

  it("PUT rejects fields that still hold placeholder text", async () => {
    const env = build();
    const res = await env.call("PUT", "/v1/admin/setup/company", { ...VALID_PROFILE, pricingPolicy: "TODO — decide pricing policy" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("pricingPolicy");
    expect(res.body.error.message).toContain("placeholder");
    const name = await env.call("PUT", "/v1/admin/setup/company", { ...VALID_PROFILE, companyName: "Your Company" });
    expect(name.status).toBe(400);
  });

  it("PUT applies defaults, persists, renders kb/company/*.md without placeholders, resyncs KB, audits", async () => {
    const env = build();
    const { website: _w, meetingLink: _m, languages: _l, differentiators: _d, proofPoints: _p, forbiddenClaims: _f, ...required } = VALID_PROFILE;
    const minimal = await env.call("PUT", "/v1/admin/setup/company", required);
    expect(minimal.status).toBe(200);
    expect(minimal.body.data.profile).toMatchObject({ website: null, meetingLink: null, languages: ["vi", "en"], proofPoints: "" });

    const res = await env.call("PUT", "/v1/admin/setup/company", VALID_PROFILE);
    expect(res.status).toBe(200);
    const profile = res.body.data.profile as CompanyProfile;
    expect(profile.updatedAt).toBeTruthy();
    expect(env.db.kv.get<CompanyProfile>("company_profile")?.companyName).toBe("Acme Logistics");
    expect((await env.call("GET", "/v1/admin/setup/company")).body.data.profile.companyName).toBe("Acme Logistics");

    const files = res.body.data.files as string[];
    expect(files.sort()).toEqual(
      ["company-overview.md", "forbidden-claims.md", "ideal-customer-profile.md", "pricing-policy.md", "product.md", "proof-points.md"].map((f) => `company/${f}`).sort(),
    );
    for (const rel of files) {
      const text = fs.readFileSync(path.join(env.config.kbRoot, rel), "utf8");
      expect(findPlaceholder(text), rel).toBeNull();
      expect(text).toMatch(/^# /m);
    }
    expect(fs.readFileSync(path.join(env.config.kbRoot, "company/product.md"), "utf8")).toContain("keeps stock levels in sync");
    expect(fs.readFileSync(path.join(env.config.kbRoot, "company/forbidden-claims.md"), "utf8")).toContain("Never promise zero overselling");
    expect(fs.readFileSync(path.join(env.config.kbRoot, "company/company-overview.md"), "utf8")).toContain("https://cal.acme.io/mai");

    // KB resynced: indexed in company scope and searchable.
    const docs = env.db.kb.listDocuments("company");
    expect(docs).toHaveLength(6);
    expect(docs.map((d) => d.title)).toContain("Acme Logistics — Product");
    expect(env.db.kb.search("overselling", ["company"], 5).length).toBeGreaterThan(0);

    const audit = env.db.audit.list({ kind: ["setup.company_saved"] });
    expect(audit.length).toBe(2);
    expect(env.events).toContain("setup.company_saved");
  });

  it("empty optional sections render explicit safe statements, not placeholders", async () => {
    const env = build();
    await env.call("PUT", "/v1/admin/setup/company", { ...VALID_PROFILE, proofPoints: "", forbiddenClaims: "", differentiators: "", meetingLink: null });
    const proof = fs.readFileSync(path.join(env.config.kbRoot, "company/proof-points.md"), "utf8");
    expect(proof).toMatch(/No customer references/);
    expect(findPlaceholder(proof)).toBeNull();
    expect(fs.readFileSync(path.join(env.config.kbRoot, "company/company-overview.md"), "utf8")).toMatch(/none configured/);
  });

  it("uses the profile's company name for {{companyName}} in role KB, and flags leftover template placeholders", async () => {
    const env = build({ useRepoTemplates: true, config: { companyName: "Your Company" } });
    const res = await env.call("PUT", "/v1/admin/setup/company", VALID_PROFILE);
    expect(res.status).toBe(200);
    expect(env.config.companyName).toBe("Acme Logistics");
    const icp = env.db.kb.listDocuments("role:sales-sdr").find((d) => d.sourcePath.endsWith("icp.md"));
    expect(icp).toBeTruthy();
    expect(icp!.body).toContain("Acme Logistics");
    expect(icp!.body).not.toContain("{{companyName}}");

    // The shipped template KB is still full of EXAMPLE/TODO text: once an SDR works from it, readiness must refuse it.
    env.db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "SDR", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    const { body } = await env.call("GET", "/v1/admin/readiness");
    const kb = (body.data.readiness as ReadinessReport).checks.find((c) => c.id === "kb.role_placeholders")!;
    expect(kb.status).toBe("warn");
    expect(kb.detail).toMatch(/sales-sdr \(.*icp\.md line 3/);
  });

  it("scans only the role KBs of roles that have an agent, and never fails readiness for them", async () => {
    const env = build({ useRepoTemplates: true });
    const roleCheck = async () => {
      const { body } = await env.call("GET", "/v1/admin/readiness");
      return (body.data.readiness as ReadinessReport).checks.find((c) => c.id === "kb.role_placeholders")!;
    };
    env.db.kb.upsertDocument({ scope: "role:account-manager", title: "Playbook", sourcePath: "/tmp/am/playbook.md", body: "# Playbook\nTODO: fill in the real refund policy." });
    // Nobody runs the account-manager role yet: its starter KB may keep TODO sections.
    expect((await roleCheck()).status).toBe("pass");

    env.db.agents.create({ id: "am-01", role: "account-manager", displayName: "AM", model: "m", workspacePath: "/tmp/am-01", policy: { builtins: [], mcp: [] } });
    const staffed = await roleCheck();
    expect(staffed.status).toBe("warn");
    expect(staffed.detail).toMatch(/account-manager \(playbook\.md/);

    // Still reported while the agent is paused (it is waiting for that KB); archived agents don't count.
    env.db.agents.setStatus("am-01", "paused");
    expect((await roleCheck()).status).toBe("warn");
    env.db.agents.setStatus("am-01", "archived");
    expect((await roleCheck()).status).toBe("pass");
  });

  it("a saved profile's name is applied to config when the API is created", async () => {
    const env = build({ config: { companyName: "Old Name" } });
    env.db.kv.set("company_profile", { ...VALID_PROFILE, updatedAt: new Date().toISOString() });
    createAdminApi({ config: env.config, db: env.db, bus: new EventBus() });
    expect(env.config.companyName).toBe("Acme Logistics");
  });
});

describe("POST /v1/admin/setup/email-test", () => {
  it("reports verify() results fresh each call", async () => {
    const env = build();
    const good = await env.call("POST", "/v1/admin/setup/email-test");
    expect(good.body.data).toMatchObject({ ok: true, error: null });
    expect(good.body.data.checkedAt).toBeTruthy();

    env.provider.setVerify({ ok: false, error: "login rejected" });
    const bad = await env.call("POST", "/v1/admin/setup/email-test");
    expect(bad.status).toBe(200);
    expect(bad.body.data).toMatchObject({ ok: false, error: "login rejected" });
  });

  it("reports failure when no provider is configured", async () => {
    const config = makeTestConfig();
    const app = createAdminApi({ config, db: openTestDb(), bus: new EventBus() });
    const res = await app.request("/v1/admin/setup/email-test", { method: "POST", headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = (await res.json()) as any;
    expect(body.data.ok).toBe(false);
    expect(body.data.error).toMatch(/no email provider/);
  });
});

describe("kill switch readiness gate", () => {
  it("refuses to enable when not ready (409 conflict listing failing checks)", async () => {
    const env = build();
    const res = await env.call("POST", "/v1/admin/killswitch", { outboundEnabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(res.body.error.message).toContain("Company profile saved");
    expect(res.body.error.message).toContain("Active Sales SDR agent");
    expect(env.db.settings.get().outboundEnabled).toBe(false);
    expect(env.db.audit.list({ kind: ["killswitch.forced"] })).toHaveLength(0);
  });

  it("enables normally once every check passes", async () => {
    const env = build();
    makeReady(env);
    expect((await env.call("PUT", "/v1/admin/setup/company", VALID_PROFILE)).status).toBe(200);
    const res = await env.call("POST", "/v1/admin/killswitch", { outboundEnabled: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.settings.outboundEnabled).toBe(true);
    expect(env.db.audit.list({ kind: ["killswitch.forced"] })).toHaveLength(0);
  });

  it("a failing live email verification blocks enabling (not a stale cache)", async () => {
    const env = build();
    makeReady(env);
    await env.call("PUT", "/v1/admin/setup/company", VALID_PROFILE);
    expect((await env.call("GET", "/v1/admin/readiness")).body.data.readiness.ready).toBe(true); // caches ok
    env.provider.setVerify({ ok: false, error: "smtp down" });
    const res = await env.call("POST", "/v1/admin/killswitch", { outboundEnabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("Email connection verified");
  });

  it("force:true overrides and is audited with the failing check ids", async () => {
    const env = build();
    const res = await env.call("POST", "/v1/admin/killswitch", { outboundEnabled: true, force: true, reason: "pilot" });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.outboundEnabled).toBe(true);
    const forced = env.db.audit.list({ kind: ["killswitch.forced"] });
    expect(forced).toHaveLength(1);
    expect((forced[0]!.data.failing as string[]).includes("company.profile")).toBe(true);
    expect((forced[0]!.data.failing as string[]).includes("agents.sdr_present")).toBe(true);
    // The forced-past failures are acknowledged so the readiness monitor doesn't immediately re-pause.
    expect(readAcknowledged(env.db)).toEqual(forced[0]!.data.failing);
  });

  it("disabling is always allowed, even when not ready", async () => {
    const env = build();
    env.db.settings.patch({ outboundEnabled: true });
    const res = await env.call("POST", "/v1/admin/killswitch", { outboundEnabled: false, reason: "incident" });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({ outboundEnabled: false, outboundDisabledReason: "incident" });
    expect(readAcknowledged(env.db)).toEqual([]);
    expect(env.db.audit.list({ kind: ["settings.changed"] }).length).toBeGreaterThan(0);
  });

  it("rejects malformed bodies", async () => {
    const env = build();
    const res = await env.call("POST", "/v1/admin/killswitch", { outboundEnabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("PATCH /settings cannot be used to bypass the gate", async () => {
    const env = build();
    const blocked = await env.call("PATCH", "/v1/admin/settings", { outboundEnabled: true });
    expect(blocked.status).toBe(409);
    expect(env.db.settings.get().outboundEnabled).toBe(false);
    // other settings are unaffected, and turning off is fine
    const rate = await env.call("PATCH", "/v1/admin/settings", { sendRatePerHour: 5 });
    expect(rate.status).toBe(200);
    expect(rate.body.data.settings.sendRatePerHour).toBe(5);
    const off = await env.call("PATCH", "/v1/admin/settings", { outboundEnabled: false });
    expect(off.status).toBe(200);
  });
});
