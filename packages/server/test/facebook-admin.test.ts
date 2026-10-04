// Admin surface of the Fanpage Manager: doctor (offline with the fake provider), scheduled posts + cancel, comments, settings,
// editing a draft's planned time, preview, KPIs, config loading, and the daemon wiring.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeFacebookProvider } from "@agyhq/channels";
import { FB_REQUIRED_PERMISSIONS } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { loadConfig } from "../src/config.ts";
import { runFacebookDoctor } from "../src/facebook/doctor.ts";
import { FacebookRuntime } from "../src/facebook/runtime.ts";
import { computeKpis } from "../src/kpis.ts";
import { EventBus } from "../src/event-bus.ts";
import { addKb, setupFanpage } from "./facebook-helpers.ts";
import { makeTestConfig, openTestDb, REPO_ROOT } from "./helpers.ts";

function buildApi(over: { provider?: FakeFacebookProvider | null; kind?: "fake" | "none" | "graph" } = {}) {
  const e = setupFanpage();
  const config = makeTestConfig({ facebook: { kind: over.kind ?? "fake", pageId: "page-1", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } as never });
  const bus = new EventBus();
  const facebook = new FacebookRuntime({ config, db: e.db, bus, provider: over.provider === undefined ? e.provider : over.provider });
  const app = createAdminApi({ config, db: e.db, bus, facebook });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { ok: boolean; data: any; error?: { message: string } } };
  };
  return { e, config, app, call, facebook };
}

describe("hq facebook doctor (runFacebookDoctor)", () => {
  it("works offline with the fake provider: token, Page identity, all five permissions pass; app mode and safety are reported", async () => {
    const e = setupFanpage();
    const config = makeTestConfig({ facebook: { kind: "fake", pageId: "page-1", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });
    const report = await runFacebookDoctor({ config, db: e.db }, e.provider, { mode: "local" });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(report.ok).toBe(true);
    expect(byId["facebook.provider"]).toMatchObject({ status: "pass" });
    expect(byId["facebook.token"]).toMatchObject({ status: "pass" });
    expect(byId["facebook.page"]).toMatchObject({ status: "pass" });
    for (const perm of FB_REQUIRED_PERMISSIONS) expect(byId[`facebook.permission.${perm}`], perm).toMatchObject({ status: "pass" });
    expect(byId["facebook.app_mode"]).toMatchObject({ status: "warn" }); // the fake reports Development
    expect(byId["facebook.lead_time"]).toMatchObject({ status: "pass" });
    expect(report.safety).toMatchObject({ outboundEnabled: true, defaultFanpageAgentId: "fp-01", pendingDrafts: 0 });
    expect(report.config).toMatchObject({ kind: "fake", pageId: "page-1", tokenEnv: null });
    expect(JSON.stringify(report)).not.toMatch(/Bearer|access_token/i);
  });

  it("fails on a missing permission, a rejected token and a Page mismatch, never on the app mode alone", async () => {
    const e = setupFanpage();
    const config = makeTestConfig({ facebook: { kind: "fake", pageId: "page-1", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });
    e.provider.setInspection({ granted: FB_REQUIRED_PERMISSIONS.filter((p) => p !== "pages_manage_engagement"), declined: ["pages_manage_engagement"] });
    let r = await runFacebookDoctor({ config, db: e.db }, e.provider);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "facebook.permission.pages_manage_engagement")).toMatchObject({ status: "fail", detail: "declined." });

    e.provider.setInspection({ granted: [...FB_REQUIRED_PERMISSIONS], declined: [], page: { id: "other-page", name: "Other" } });
    r = await runFacebookDoctor({ config, db: e.db }, e.provider);
    expect(r.checks.find((c) => c.id === "facebook.page")).toMatchObject({ status: "fail" });

    e.provider.setInspection({ page: { id: "page-1", name: "Eval Page" }, tokenValid: false, tokenError: "Session has expired" });
    r = await runFacebookDoctor({ config, db: e.db }, e.provider);
    expect(r.checks.find((c) => c.id === "facebook.token")).toMatchObject({ status: "fail", detail: "Session has expired" });
    expect(r.checks.some((c) => c.id === "facebook.page")).toBe(false); // nothing more is checked with a dead token
  });

  it("warns (never passes) when the token type cannot list its permissions, and reports the app mode as declared", async () => {
    const e = setupFanpage();
    const config = makeTestConfig({ facebook: { kind: "fake", pageId: "page-1", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });
    e.provider.setInspection({ granted: null, appMode: "live" });
    const r = await runFacebookDoctor({ config, db: e.db }, e.provider);
    expect(r.checks.find((c) => c.id === "facebook.permissions")).toMatchObject({ status: "warn" });
    expect(r.checks.find((c) => c.id === "facebook.app_mode")).toMatchObject({ status: "pass" });
    expect(r.ok).toBe(true);
  });

  it("reports the app secret and appsecret_proof (set or not), never their values", async () => {
    const e = setupFanpage();
    const config = makeTestConfig({ facebook: { kind: "graph", pageId: "page-1", appId: "1234567890", apiVersion: "v21.0", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });
    const env = { AGYHQ_FB_PAGE_TOKEN: "FAKE-token-123", AGYHQ_FB_APP_SECRET: "FAKE-secret-456" };

    e.provider.setInspection({ appSecretProof: true });
    let r = await runFacebookDoctor({ config, db: e.db }, e.provider, { env });
    expect(r.config).toMatchObject({ appId: "1234567890", appSecretPresent: true, tokenPresent: true });
    expect(r.checks.find((c) => c.id === "facebook.app_secret")).toMatchObject({ status: "pass" });
    expect(r.inspection!.appSecretProof).toBe(true);

    e.provider.setInspection({ appSecretProof: false });
    r = await runFacebookDoctor({ config, db: e.db }, e.provider, { env });
    expect(r.checks.find((c) => c.id === "facebook.app_secret")).toMatchObject({ status: "warn", detail: expect.stringContaining("restart the daemon") });

    r = await runFacebookDoctor({ config, db: e.db }, e.provider, { env: { AGYHQ_FB_PAGE_TOKEN: "FAKE-token-123" } });
    expect(r.config.appSecretPresent).toBe(false);
    expect(r.checks.find((c) => c.id === "facebook.app_secret")).toMatchObject({ status: "warn", detail: expect.stringContaining("Require App Secret") });
    expect(r.ok).toBe(true); // optional: a missing secret is a warning

    const json = JSON.stringify(r);
    for (const secret of ["FAKE-token-123", "FAKE-secret-456"]) expect(json).not.toContain(secret);

    const fake = await runFacebookDoctor({ config: makeTestConfig({ facebook: { kind: "fake", pageId: "page-1", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } }), db: e.db }, e.provider);
    expect(fake.checks.some((c) => c.id === "facebook.app_secret")).toBe(false); // nothing to sign offline
  });

  it("not configured and token env var missing are failing checks with the reason", async () => {
    const db = openTestDb();
    const none = await runFacebookDoctor({ config: makeTestConfig(), db }, null);
    expect(none.ok).toBe(false);
    expect(none.checks[0]).toMatchObject({ id: "facebook.provider", status: "fail" });
    const graph = makeTestConfig({ facebook: { kind: "graph", pageId: "1", apiVersion: "v21.0", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });
    const noToken = await runFacebookDoctor({ config: graph, db }, null, { providerError: "environment variable AGYHQ_FB_PAGE_TOKEN is not set", env: {} });
    expect(noToken.checks[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("AGYHQ_FB_PAGE_TOKEN") });
    expect(noToken.config).toMatchObject({ kind: "graph", tokenEnv: "AGYHQ_FB_PAGE_TOKEN", tokenPresent: false });
  });

  it("flags a short lead time and a live path (kill switch off + shadow agents = nothing can be sent)", async () => {
    const e = setupFanpage({ trustTier: "assisted" });
    const config = makeTestConfig({ facebook: { kind: "fake", pageId: "page-1", pollIntervalMs: 120_000, scheduleLeadHours: 2, lookbackDays: 14 } });
    const r = await runFacebookDoctor({ config, db: e.db }, e.provider);
    expect(r.checks.find((c) => c.id === "facebook.lead_time")).toMatchObject({ status: "warn" });
    expect(r.checks.find((c) => c.id === "facebook.safety")).toMatchObject({ status: "warn" }); // outbound on + assisted agent
    e.db.settings.patch({ outboundEnabled: false });
    expect((await runFacebookDoctor({ config, db: e.db }, e.provider)).safety.nothingCanBeSent).toBe(true);
  });
});

describe("admin routes", () => {
  it("POST /doctor runs the doctor through the daemon; GET /status reports the channel", async () => {
    const t = buildApi();
    const doc = await t.call("POST", "/v1/admin/facebook/doctor");
    expect(doc.status).toBe(200);
    expect(doc.body.data.report).toMatchObject({ mode: "daemon", ok: true });
    const status = await t.call("GET", "/v1/admin/facebook/status");
    expect(status.body.data.status).toMatchObject({ kind: "fake", configured: true, pageId: "page-1", scheduleLeadHours: 24 });
    expect(status.body.data.commentsByStatus).toMatchObject({ new: 0, assigned: 0 });
  });

  it("scheduled posts: lists what Facebook holds, cancels one, falls back to what we sent when the provider fails", async () => {
    const t = buildApi();
    const at = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const a = await t.e.provider.createPost({ message: "Bài A", mode: "scheduled", scheduledPublishTime: at });
    t.e.db.facebook.recordAgentPost({ id: a.postId, message: "Bài A", permalinkUrl: null, createdTime: new Date().toISOString(), isPublished: false, scheduledPublishTime: at, outboxId: "obx_a" });
    const listed = await t.call("GET", "/v1/admin/facebook/scheduled");
    expect(listed.body.data).toMatchObject({ source: "facebook", error: null, posts: [{ postId: a.postId, message: "Bài A", outboxId: "obx_a" }] });

    t.e.provider.failNext("listScheduledPosts", new Error("graph down"));
    const fallback = await t.call("GET", "/v1/admin/facebook/scheduled");
    expect(fallback.body.data).toMatchObject({ source: "local", error: "graph down", posts: [{ postId: a.postId }] });

    const draft = t.e.db.outbox.createDraft({ agentId: t.e.agentId, channel: "facebook_post", to: "fb:page:page-1", body: "Bài A", reason: "r", payload: { kind: "post", postType: "tip", link: null, sourceUrl: null, publishAt: null } });
    t.e.db.sqlite.prepare("UPDATE fb_posts SET outbox_id = ? WHERE id = ?").run(draft.id, a.postId);
    const cancelled = await t.call("POST", `/v1/admin/facebook/scheduled/${encodeURIComponent(a.postId)}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(t.e.provider.cancelled).toEqual([a.postId]);
    expect((await t.call("GET", "/v1/admin/facebook/scheduled")).body.data.posts).toEqual([]);
    expect(t.e.db.outbox.get(draft.id)!.statusReason).toMatch(/cancelled/);
    expect(t.e.db.audit.list({ kind: ["facebook.scheduled_cancelled"] })).toHaveLength(1);
    expect((await t.call("POST", `/v1/admin/facebook/scheduled/${encodeURIComponent(a.postId)}/cancel`)).status).toBe(500); // already gone: provider says not_found
  });

  it("scheduled routes say so when no provider is configured", async () => {
    const t = buildApi({ provider: null, kind: "none" });
    const listed = await t.call("GET", "/v1/admin/facebook/scheduled");
    expect(listed.body.data).toMatchObject({ source: "local", posts: [] });
    expect((await t.call("POST", "/v1/admin/facebook/scheduled/x/cancel")).status).toBe(400);
  });

  it("lists comments by status", async () => {
    const t = buildApi();
    t.e.ingestComment({ id: "c1" });
    t.e.ingestComment({ id: "c-own", from: { id: "page-1", name: "Page" } });
    const own = await t.call("GET", "/v1/admin/facebook/comments?status=own");
    expect(own.body.data.comments.map((c: { id: string }) => c.id)).toEqual(["c-own"]);
    expect((await t.call("GET", "/v1/admin/facebook/comments")).body.data.comments).toHaveLength(2);
  });

  it("previews a pending post draft as an unpublished post (and nothing else)", async () => {
    const t = buildApi();
    addKb(t.e.db, "Mẹo: đặt tồn kho tối thiểu.");
    const draft = (await t.e.call("fb_draft_post", { postType: "tip", message: "Mẹo: đặt tồn kho tối thiểu.", reason: "KB" }, t.e.newTask("fanpage.draft_post"))).data!.item;
    const res = await t.call("POST", `/v1/admin/facebook/preview/${draft.id}`);
    expect(res.status).toBe(200);
    expect(t.e.provider.created.map((c) => c.post.mode)).toEqual(["preview"]);
    expect(t.e.db.outbox.get(draft.id)!.status).toBe("pending_approval"); // still waiting for a human
    const reply = (await t.e.call("fb_draft_reply", { commentId: t.e.ingestComment({ id: "c1" }), message: "Dạ có ạ.", reason: "r" })).data!.item;
    expect((await t.call("POST", `/v1/admin/facebook/preview/${reply.id}`)).status).toBe(400);
  });

  it("PATCH settings accepts defaultFanpageAgentId only for an active fanpage-manager agent (or null)", async () => {
    const t = buildApi();
    t.e.db.agents.create({ id: "sdr-x", role: "sales-sdr", displayName: "S", model: "m", workspacePath: "/tmp/x", policy: { builtins: [], mcp: [] } });
    expect((await t.call("PATCH", "/v1/admin/settings", { defaultFanpageAgentId: "sdr-x" })).status).toBe(400);
    expect((await t.call("PATCH", "/v1/admin/settings", { defaultFanpageAgentId: "nope" })).status).toBe(400);
    const ok = await t.call("PATCH", "/v1/admin/settings", { defaultFanpageAgentId: "fp-01" });
    expect(ok.body.data.settings.defaultFanpageAgentId).toBe("fp-01");
    expect((await t.call("PATCH", "/v1/admin/settings", { defaultFanpageAgentId: null })).body.data.settings.defaultFanpageAgentId).toBeNull();
  });

  it("PATCH outbox changes the planned time of a post draft (and re-lints), and refuses publishAt on anything else", async () => {
    const t = buildApi();
    addKb(t.e.db, "Mẹo: đặt tồn kho tối thiểu.");
    const draft = (await t.e.call("fb_draft_post", { postType: "tip", message: "Mẹo: đặt tồn kho tối thiểu.", reason: "KB" }, t.e.newTask("fanpage.draft_post"))).data!.item;
    const edited = await t.call("PATCH", `/v1/admin/outbox/${draft.id}`, { publishAt: "2026-10-12T02:00:00.000Z" });
    expect(edited.status).toBe(200);
    expect(edited.body.data.item.payload).toMatchObject({ kind: "post", publishAt: "2026-10-12T02:00:00.000Z" });
    expect(edited.body.data.item.editedByHuman).toBe(true);
    const textEdit = await t.call("PATCH", `/v1/admin/outbox/${draft.id}`, { body: "Mẹo: đặt [tồn kho] tối thiểu." });
    expect(textEdit.body.data.item.lint.map((f: { code: string }) => f.code)).toContain("placeholder"); // re-linted as a Facebook post

    const email = t.e.db.outbox.createDraft({ agentId: t.e.agentId, channel: "email", to: "a@b.co", subject: "s", body: "b", reason: "r" });
    expect((await t.call("PATCH", `/v1/admin/outbox/${email.id}`, { publishAt: "2026-10-12T02:00:00.000Z" })).status).toBe(400);
  });

  it("approving a Facebook draft follows the same rules as email: lint errors block it, a shadow agent's approval is held", async () => {
    const t = buildApi();
    t.e.db.agents.update(t.e.agentId, { trustTier: "shadow" });
    const draft = (await t.e.call("fb_draft_reply", { commentId: t.e.ingestComment({ id: "c1" }), message: "Dạ có ạ.", reason: "r" })).data!.item;
    const approved = await t.call("POST", `/v1/admin/outbox/${draft.id}/approve`, {});
    expect(approved.body.data.item.status).toBe("held"); // practice: nothing is ever sent for a shadow agent
    expect(t.e.provider.replies).toEqual([]);
  });
});

describe("KPIs", () => {
  it("reports the fanpage numbers with real counts", async () => {
    const e = setupFanpage();
    addKb(e.db, "Mẹo: đặt tồn kho tối thiểu.");
    const c1 = e.ingestComment({ id: "c1" });
    const c2 = e.ingestComment({ id: "c2", message: "Spam" });
    e.ingestComment({ id: "c-own", from: { id: "page-1", name: "Page" } });
    const reply = (await e.call("fb_draft_reply", { commentId: c1, message: "Dạ có ạ.", reason: "r" })).data!.item;
    await e.call("fb_propose_hide", { commentId: c2, reason: "spam" });
    await e.call("fb_draft_post", { postType: "tip", message: "Mẹo: đặt tồn kho tối thiểu.", reason: "KB" }, e.newTask("fanpage.draft_post"));
    e.db.outbox.decide(reply.id, "approved", { decidedBy: "human:ops" });
    await e.sender().tick();

    const k = computeKpis(e.db, 7, new Date(Date.now() + 60_000)).roles["fanpage-manager"];
    expect(k).toEqual({ agents: 1, postsDrafted: 1, postsScheduled: 0, commentsReceived: 2, repliesDrafted: 1, repliesSent: 1, hideProposals: 1, escalations: 0, handoffs: 0 });
  });
});

describe("config", () => {
  const load = (facebook: unknown, env: NodeJS.ProcessEnv = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-fbcfg-"));
    const file = path.join(dir, "agyhq.config.json");
    fs.writeFileSync(file, JSON.stringify({ dataDir: dir, adminToken: "t", ...(facebook === undefined ? {} : { facebook }) }));
    return loadConfig({ configPath: file, env: { ...env } });
  };

  it("defaults to none with the documented knobs", () => {
    expect(load(undefined).facebook).toEqual({ kind: "none", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 });
  });

  it("agyhq.config.example.json still loads, with the facebook block off", () => {
    const cfg = loadConfig({ configPath: path.join(REPO_ROOT, "agyhq.config.example.json"), env: { AGYHQ_ADMIN_TOKEN: "t" } });
    expect(cfg.facebook).toEqual({ kind: "none", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 });
  });

  it("loads a graph block (token env var name, not the token) and a fake block", () => {
    const graph = load({ kind: "graph", pageId: "123", apiVersion: "v21.0", tokenEnv: "MY_TOKEN", appMode: "development", pollIntervalMs: 60_000, scheduleLeadHours: 48 });
    expect(graph.facebook).toMatchObject({ kind: "graph", pageId: "123", apiVersion: "v21.0", tokenEnv: "MY_TOKEN", appMode: "development", pollIntervalMs: 60_000, scheduleLeadHours: 48, lookbackDays: 14 });
    expect(JSON.stringify(graph.facebook)).not.toMatch(/accessToken/);
    expect(load({ kind: "fake", pageId: "p" }).facebook).toMatchObject({ kind: "fake", pageId: "p" });
  });

  it("takes appId from the file but refuses any secret in it: the token and the app secret come from the environment", () => {
    expect(load({ kind: "graph", pageId: "1", apiVersion: "v21.0", appId: "1234567890" }).facebook).toMatchObject({ kind: "graph", appId: "1234567890" });
    expect(() => load({ kind: "graph", pageId: "1", apiVersion: "v21.0", accessToken: "FAKE" })).toThrow(/accessToken/);
    expect(() => load({ kind: "graph", pageId: "1", apiVersion: "v21.0", appSecret: "FAKE" })).toThrow(/appSecret/);
    expect(() => load({ kind: "graph", pageId: "1", apiVersion: "v21.0", token: "FAKE" })).toThrow(/token/);
  });

  it("rejects a bad block with a clear message (no page id, bad api version, too-short lead time)", () => {
    expect(() => load({ kind: "graph", apiVersion: "v21.0" })).toThrow(/pageId/);
    expect(() => load({ kind: "graph", pageId: "1", apiVersion: "21" })).toThrow(/apiVersion/);
    expect(() => load({ kind: "fake", scheduleLeadHours: 0.5 })).toThrow(/scheduleLeadHours/);
  });
});

describe("FacebookRuntime", () => {
  it("a graph config without the token env var does not crash the daemon: no provider, configError says why", () => {
    const e = setupFanpage();
    const config = makeTestConfig({ facebook: { kind: "graph", pageId: "123", apiVersion: "v21.0", tokenEnv: "NOPE_FB_TOKEN", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });
    const rt = new FacebookRuntime({ config, db: e.db, bus: new EventBus(), env: {} });
    expect(rt.provider).toBeNull();
    expect(rt.configError).toMatch(/NOPE_FB_TOKEN/);
    expect(rt.pageId).toBe("123"); // drafts still have a target
    expect(rt.status()).toMatchObject({ kind: "graph", configured: false });
    rt.start(); // idle, no timers
  });

  it("builds the provider from the token env var", () => {
    const e = setupFanpage();
    const config = makeTestConfig({ facebook: { kind: "graph", pageId: "123", apiVersion: "v21.0", tokenEnv: "MY_FB_TOKEN", pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });
    const rt = new FacebookRuntime({ config, db: e.db, bus: new EventBus(), env: { MY_FB_TOKEN: "abc" } });
    expect(rt.provider?.kind).toBe("graph");
    expect(rt.configError).toBeNull();
  });
});
