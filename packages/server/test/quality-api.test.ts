import { describe, expect, it } from "vitest";
import { mcpRoute } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { EventBus, type BusEvent } from "../src/event-bus.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";
import { setupTestApi } from "./agent-api/test-helpers.ts";
import { addAgent, seedDraft } from "./quality-helpers.ts";

const KB_PRICING = "# Pricing\nGrowth plan: 1.500.000đ/tháng.";
const GOOD = { to: "lead@acme.com", subject: "Stock sync", body: "Hi Lan, saw you sell on Shopee and your site. Worth a 15 minute call?", reason: "first touch" };

describe("outbox_draft_email lint enforcement", () => {
  it("creates the draft and stores non-blocking findings", async () => {
    const { db, request } = setupTestApi();
    const res = await request(mcpRoute("outbox_draft_email"), { ...GOOD, body: "We sell stock sync software. It works on every channel." });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { item: { status: string; lint: { code: string; severity: string }[] } } };
    expect(json.data.item.status).toBe("pending_approval");
    expect(json.data.item.lint.map((f) => f.code)).toContain("no_cta");
    expect(json.data.item.lint.every((f) => f.severity !== "error")).toBe(true);
    expect(db.outbox.list({})[0]!.lint.map((f) => f.code)).toContain("no_cta"); // persisted
  });

  it("does NOT create the draft on an error finding, tells the agent what to fix, and audits outbox.lint_blocked", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    const res = await request(mcpRoute("outbox_draft_email"), { ...GOOD, body: "Hi [Name], it costs 2 triệu/tháng. Worth a call?" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: false; error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_request");
    expect(json.error.message).toContain("Draft NOT created");
    expect(json.error.message).toContain("placeholder");
    expect(json.error.message).toContain("unknown_price");
    expect(json.error.message).toContain("call outbox_draft_email again");

    expect(db.outbox.list({})).toHaveLength(0);
    expect(db.audit.list({ agentId, taskId, kind: ["outbox.drafted"] })).toHaveLength(0);
    const blocked = db.audit.list({ agentId, taskId, kind: ["outbox.lint_blocked"] });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.data["to"]).toBe("lead@acme.com");
    expect((blocked[0]!.data["findings"] as { code: string }[]).map((f) => f.code).sort()).toEqual(["placeholder", "unknown_price"]);
  });

  it("allows a price that is grounded in the KB (kb text read from the agent's scopes)", async () => {
    const { db, request } = setupTestApi();
    db.kb.upsertDocument({ scope: "company", title: "Pricing", sourcePath: "pricing.md", body: KB_PRICING });
    const ok = await request(mcpRoute("outbox_draft_email"), { ...GOOD, body: "Gói Growth chỉ 1,5 triệu mỗi tháng. Anh có muốn xem demo không?" });
    expect(ok.status).toBe(200);
    const bad = await request(mcpRoute("outbox_draft_email"), { ...GOOD, body: "Gói Growth chỉ 1 triệu mỗi tháng. Anh có muốn xem demo không?" });
    expect(bad.status).toBe(400);
  });

  it("uses the company profile's forbidden claims and meeting link", async () => {
    const { db, request } = setupTestApi();
    db.kv.set("company_profile", { forbiddenClaims: "- We are the cheapest", meetingLink: "https://cal.example.com/acme" });
    const res = await request(mcpRoute("outbox_draft_email"), { ...GOOD, body: "We are the cheapest tool around. Worth a call?" });
    expect(res.status).toBe(400);
    const ok = await request(mcpRoute("outbox_draft_email"), { ...GOOD, body: "Book here https://cal.example.com/acme" });
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { data: { item: { lint: { code: string }[] } } };
    expect(json.data.item.lint.map((f) => f.code)).not.toContain("no_cta");
  });

  it("blocks a 'Re:' subject without a prior thread but allows it after the contact wrote in", async () => {
    const { db, request } = setupTestApi();
    const res = await request(mcpRoute("outbox_draft_email"), { ...GOOD, subject: "Re: your question" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("deceptive_subject");

    db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "lead@acme.com", subject: "question", bodyText: "hi", classification: "reply" });
    const ok = await request(mcpRoute("outbox_draft_email"), { ...GOOD, subject: "Re: your question" });
    expect(ok.status).toBe(200);
  });

  it("stores a policy-blocked draft even when lint would also fail (the human should see why)", async () => {
    const { db, request } = setupTestApi();
    db.crm.upsertContact({ email: "optout@acme.com", attributes: { optOut: true } });
    const res = await request(mcpRoute("outbox_draft_email"), { ...GOOD, to: "optout@acme.com", body: "Hi [Name]. Worth a call?" });
    expect(res.status).toBe(200);
    const item = ((await res.json()) as { data: { item: { status: string; lint: { code: string }[] } } }).data.item;
    expect(item.status).toBe("blocked");
    expect(item.lint.map((f) => f.code)).toContain("placeholder");
  });
});

function buildAdmin() {
  const config = makeTestConfig();
  const db = openTestDb();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const app = createAdminApi({ config, db, bus });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { db, call, events };
}

describe("re-lint", () => {
  it("re-runs lint after a human PATCH edit (fixing and breaking findings)", async () => {
    const { db, call } = buildAdmin();
    addAgent(db, "sdr-01", "assisted");
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "lead@acme.com", subject: "Hi", body: "Hi [Name], worth a call?", reason: "r", lint: [{ code: "placeholder", severity: "error", message: "x" }] });

    const fixed = await call("PATCH", `/v1/admin/outbox/${draft.id}`, { body: "Hi Lan, worth a call?" });
    expect(fixed.status).toBe(200);
    expect(fixed.json.data.item.lint).toEqual([]);
    expect(db.outbox.get(draft.id)!.lint).toEqual([]);

    const broken = await call("PATCH", `/v1/admin/outbox/${draft.id}`, { body: "Hi Lan, it is $49 per seat. Worth a call?" });
    expect(broken.json.data.item.lint.map((f: { code: string }) => f.code)).toContain("unknown_price");
    expect(db.outbox.get(draft.id)!.lint.map((f) => f.code)).toContain("unknown_price");
  });

  it("POST /relint re-checks against the current KB, 404s for unknown ids", async () => {
    const { db, call } = buildAdmin();
    addAgent(db, "sdr-01", "assisted");
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "lead@acme.com", subject: "Hi", body: "Gói Growth 1.500.000đ/tháng. Anh rảnh không?", reason: "r" });
    expect(draft.lint).toEqual([]);

    const before = await call("POST", `/v1/admin/outbox/${draft.id}/relint`);
    expect(before.json.data.item.lint.map((f: { code: string }) => f.code)).toContain("unknown_price");

    db.kb.upsertDocument({ scope: "company", title: "Pricing", sourcePath: "p.md", body: KB_PRICING });
    const after = await call("POST", `/v1/admin/outbox/${draft.id}/relint`);
    expect(after.json.data.item.lint).toEqual([]);

    expect((await call("POST", "/v1/admin/outbox/obx_nope/relint")).status).toBe(404);
  });
});

describe("reject with category", () => {
  function setup() {
    const ctx = buildAdmin();
    addAgent(ctx.db, "sdr-01", "assisted");
    const draft = ctx.db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "s", body: "b", reason: "r", threadKey: "contact:a@x.com" });
    return { ...ctx, draft };
  }

  it("stores the category, keeps status/decisionNote, writes agent memory that includes the category", async () => {
    const { db, call, draft, events } = setup();
    const res = await call("POST", `/v1/admin/outbox/${draft.id}/reject`, { reason: "too pushy", category: "tone", reviewer: "ops" });
    expect(res.status).toBe(200);
    expect(res.json.data.item).toMatchObject({ status: "rejected", decisionNote: "too pushy", rejectionCategory: "tone", decidedBy: "human:ops" });
    expect(db.outbox.get(draft.id)!.rejectionCategory).toBe("tone");

    const memories = db.memory.list("sdr-01", { subject: "contact:a@x.com" });
    expect(memories).toHaveLength(1);
    expect(memories[0]!.status).toBe("accepted");
    expect(memories[0]!.content).toBe("Human rejected your draft to a@x.com (tone): too pushy");

    const audit = db.audit.list({ kind: ["outbox.rejected"] });
    expect(audit[0]!.data["category"]).toBe("tone");
    expect(events.some((e) => e.type === "outbox.updated" && e.data["status"] === "rejected")).toBe(true);
  });

  it("defaults the category to other, still requires a reason, and rejects unknown categories", async () => {
    const { db, call, draft } = setup();
    expect((await call("POST", `/v1/admin/outbox/${draft.id}/reject`, {})).status).toBe(400);
    expect((await call("POST", `/v1/admin/outbox/${draft.id}/reject`, { reason: "x", category: "vibes" })).status).toBe(400);
    const res = await call("POST", `/v1/admin/outbox/${draft.id}/reject`, { reason: "nope" });
    expect(res.json.data.item.rejectionCategory).toBe("other");
    expect(db.memory.list("sdr-01")[0]!.content).toContain("(other): nope");
    expect((await call("POST", `/v1/admin/outbox/${draft.id}/reject`, { reason: "again" })).status).toBe(409);
  });
});

describe("scorecards + criteria + promote routes", () => {
  function seedGood(db: ReturnType<typeof openTestDb>, id: string, n = 5) {
    for (let i = 0; i < n; i++) seedDraft(db, id, { status: i % 2 ? "held" : "sent", to: `p${i}@x.com`, reviewMinutes: 5 });
  }

  it("GET /scorecards returns criteria and a card per non-archived agent; validates days", async () => {
    const { db, call } = buildAdmin();
    addAgent(db, "sdr-01", "shadow");
    addAgent(db, "sdr-02", "autonomous");
    addAgent(db, "gone", "shadow");
    db.agents.setStatus("gone", "archived");
    seedGood(db, "sdr-01");

    const res = await call("GET", "/v1/admin/scorecards?days=7");
    expect(res.status).toBe(200);
    expect(res.json.data.days).toBe(7);
    expect(res.json.data.criteria.minDecided).toBe(30);
    const byId = Object.fromEntries(res.json.data.scorecards.map((s: any) => [s.agentId, s]));
    expect(Object.keys(byId).sort()).toEqual(["sdr-01", "sdr-02"]);
    expect(byId["sdr-01"].decided).toBe(5);
    expect(byId["sdr-01"].promotion.nextTier).toBe("assisted");
    expect(byId["sdr-02"].promotion).toBeNull();

    expect((await call("GET", "/v1/admin/scorecards")).json.data.days).toBe(14);
    expect((await call("GET", "/v1/admin/scorecards?days=0")).status).toBe(400);
    expect((await call("GET", "/v1/admin/scorecards?days=abc")).status).toBe(400);
    expect((await call("GET", "/v1/admin/scorecards?agentId=sdr-02")).json.data.scorecards).toHaveLength(1);
  });

  it("GET/PUT /promotion-criteria merge over the defaults and validate", async () => {
    const { call } = buildAdmin();
    expect((await call("GET", "/v1/admin/promotion-criteria")).json.data.criteria.minApprovalRate).toBe(0.85);
    const put = await call("PUT", "/v1/admin/promotion-criteria", { minDecided: 5, minApprovalRate: 0.7 });
    expect(put.json.data.criteria).toMatchObject({ minDecided: 5, minApprovalRate: 0.7, maxMedianEditRatio: 0.15 });
    expect((await call("GET", "/v1/admin/promotion-criteria")).json.data.criteria.minDecided).toBe(5);
    expect((await call("PUT", "/v1/admin/promotion-criteria", { minApprovalRate: 1.5 })).status).toBe(400);
    expect((await call("PUT", "/v1/admin/promotion-criteria", { unknownKey: 1 })).status).toBe(400);
    expect((await call("PUT", "/v1/admin/promotion-criteria", { minDecided: 1.5 })).status).toBe(400);
  });

  it("promote: 409 with reasons when not eligible; succeeds once criteria are met; audited; emits agent.updated", async () => {
    const { db, call, events } = buildAdmin();
    addAgent(db, "sdr-01", "shadow");
    seedGood(db, "sdr-01");

    const refused = await call("POST", "/v1/admin/agents/sdr-01/promote", {});
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("conflict");
    expect(refused.json.error.message).toContain("decided drafts 5 < 30");
    expect(db.agents.get("sdr-01")!.trustTier).toBe("shadow");

    await call("PUT", "/v1/admin/promotion-criteria", { minDecided: 5 });
    const res = await call("POST", "/v1/admin/agents/sdr-01/promote", { note: "two weeks clean" });
    expect(res.status).toBe(200);
    expect(res.json.data.agent.trustTier).toBe("assisted");
    expect(db.agents.get("sdr-01")!.trustTier).toBe("assisted");

    const audit = db.audit.list({ kind: ["agent.promoted"] });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.agentId).toBe("sdr-01");
    expect(audit[0]!.data).toMatchObject({ from: "shadow", to: "assisted", forced: false, note: "two weeks clean" });
    expect(events.some((e) => e.type === "agent.updated" && e.data["agentId"] === "sdr-01" && e.data["promoted"] === true)).toBe(true);
  });

  it("promote with force overrides unmet criteria and records it; autonomous cannot be promoted; unknown agent 404", async () => {
    const { db, call } = buildAdmin();
    addAgent(db, "sdr-01", "assisted");
    const forced = await call("POST", "/v1/admin/agents/sdr-01/promote", { force: true, note: "owner decision" });
    expect(forced.status).toBe(200);
    expect(forced.json.data.agent.trustTier).toBe("autonomous");
    const audit = db.audit.list({ kind: ["agent.promoted"] })[0]!;
    expect(audit.data).toMatchObject({ from: "assisted", to: "autonomous", forced: true });
    expect((audit.data["unmet"] as string[]).length).toBeGreaterThan(0);

    const again = await call("POST", "/v1/admin/agents/sdr-01/promote", { force: true });
    expect(again.status).toBe(409);
    expect(again.json.error.message).toContain("highest trust tier");
    expect((await call("POST", "/v1/admin/agents/nope/promote", {})).status).toBe(404);
  });
});
