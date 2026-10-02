import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROMOTION_CRITERIA } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { EventBus, type BusEvent } from "../src/event-bus.ts";
import { checkCriteria } from "../src/quality/scorecard.ts";
import { buildDigestSnapshot } from "../src/routines/run.ts";
import { buildShadowDigest, computeShadowStatus, shadowVerdict, type VerdictInput } from "../src/shadow.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";
import { addAgent, seedDraft } from "./quality-helpers.ts";

const DAY = 86_400_000;
const c = DEFAULT_PROMOTION_CRITERIA; // 30 decided, 85% approval, 15% edit, 0 compliance, 5% lint

function verdictFor(p: Partial<{ decided: number; drafts: number; approvalRate: number | null; medianEditRatio: number | null; compliance: number; lintErrorRate: number | null; elapsedDays: number; ended: boolean }>) {
  const decided = p.decided ?? 0;
  const sc = {
    decided,
    approvalRate: p.approvalRate === undefined ? (decided ? 1 : null) : p.approvalRate,
    medianEditRatio: p.medianEditRatio === undefined ? (decided ? 0 : null) : p.medianEditRatio,
    rejectionsByCategory: p.compliance ? { compliance: p.compliance } : {},
    lintErrorRate: p.lintErrorRate === undefined ? (decided ? 0 : null) : p.lintErrorRate,
  };
  const input: VerdictInput = {
    criteria: c,
    checks: checkCriteria(sc, c),
    drafts: p.drafts ?? decided,
    decided,
    elapsedDays: p.elapsedDays ?? 7,
    plannedDays: 14,
    ended: p.ended ?? false,
  };
  return shadowVerdict(input);
}

describe("shadowVerdict", () => {
  it("not enough data when nothing or too little has been decided", () => {
    expect(verdictFor({})).toMatchObject({ status: "not_enough_data", reason: "no drafts yet" });
    expect(verdictFor({ drafts: 4 })).toMatchObject({ status: "not_enough_data" });
    // a terrible rate on 4 decisions is noise, not a verdict
    expect(verdictFor({ decided: 4, approvalRate: 0.25 }).status).toBe("not_enough_data");
  });

  it("below bar once the sample is big enough and a rate misses", () => {
    const v = verdictFor({ decided: 12, approvalRate: 0.6 });
    expect(v.status).toBe("below_bar");
    expect(v.reason).toContain("approval rate 60% < 85%");
    expect(verdictFor({ decided: 12, medianEditRatio: 0.4 }).reason).toContain("median edit ratio 40% > 15%");
    expect(verdictFor({ decided: 12, drafts: 12, lintErrorRate: 0.2 }).reason).toContain("lint error rate 20% > 5%");
  });

  it("a compliance rejection is below bar at any volume", () => {
    const v = verdictFor({ decided: 2, compliance: 1 });
    expect(v.status).toBe("below_bar");
    expect(v.reason).toContain("compliance rejections 1 > 0");
  });

  it("on track when rates are fine and volume is met or projected", () => {
    expect(verdictFor({ decided: 31 }).status).toBe("on_track");
    // 16 decided in 7 of 14 days -> ~32 projected
    const v = verdictFor({ decided: 16, elapsedDays: 7 });
    expect(v.status).toBe("on_track");
    expect(v.reason).toContain("pace projects ~32 by day 14");
  });

  it("not enough data when quality is fine but the pace misses the volume target; a finished run is not projected", () => {
    const slow = verdictFor({ decided: 12, elapsedDays: 7 });
    expect(slow.status).toBe("not_enough_data");
    expect(slow.reason).toContain("pace projects only ~24");
    const ended = verdictFor({ decided: 20, elapsedDays: 14, ended: true });
    expect(ended.status).toBe("not_enough_data");
    expect(ended.reason).toContain("only 20/30 drafts were decided");
  });
});

function setup() {
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

/** 14 days planned, started 5.5 days ago; sdr-01 has a realistic mix of review outcomes. */
function seedRun() {
  const t = setup();
  addAgent(t.db, "sdr-01");
  const startedAt = new Date(Date.now() - 5.5 * DAY).toISOString();
  const run = t.db.shadowRuns.create({ plannedDays: 14, agentIds: ["sdr-01"], startedAt, notes: "pilot" });
  let n = 0;
  const to = () => `p${n++}@x.com`;
  // day 1-2: 10 unchanged
  for (let i = 0; i < 10; i++) seedDraft(t.db, "sdr-01", { status: "held", to: to(), daysAgo: 4.8 - i * 0.05, reviewMinutes: 20 });
  // 3 edited approvals (edit ratio ~0.1 / 0.1 / 0.5)
  seedDraft(t.db, "sdr-01", { status: "held", to: to(), original: "abcdefghij", final: "abcdefghiX", daysAgo: 2 });
  seedDraft(t.db, "sdr-01", { status: "held", to: to(), original: "abcdefghij", final: "abcdefghiY", daysAgo: 2 });
  seedDraft(t.db, "sdr-01", { status: "held", to: to(), original: "aaaaaaaaaa", final: "aaaaabbbbb", daysAgo: 1.5 });
  // 2 rejections
  seedDraft(t.db, "sdr-01", { status: "rejected", to: to(), category: "tone", daysAgo: 1 });
  seedDraft(t.db, "sdr-01", { status: "rejected", to: to(), category: "tone", daysAgo: 1 });
  // a draft with a lint error that was rejected + a pending one (30h old)
  seedDraft(t.db, "sdr-01", { status: "rejected", to: to(), category: "factual_error", daysAgo: 0.5, lint: [{ code: "unknown_price", severity: "error", message: "x" }] });
  seedDraft(t.db, "sdr-01", { status: "pending_approval", to: to(), daysAgo: 1.25 });
  // outside the run window: ignored
  seedDraft(t.db, "sdr-01", { status: "held", to: to(), daysAgo: 9 });
  return { ...t, run };
}

describe("computeShadowStatus", () => {
  it("counts drafts, approvals, edits, rejections, lint and pending over the run window only", () => {
    const { db, run } = seedRun();
    const st = computeShadowStatus(db, run);
    expect(st).toMatchObject({ active: true, day: 6, plannedDays: 14, daysRemaining: 9, complete: false });
    const a = st.agents[0]!;
    expect(a.drafts).toBe(17);
    expect(a.approvedUnchanged).toBe(10);
    expect(a.approvedEdited).toBe(3);
    expect(a.rejected).toBe(3);
    expect(a.rejectionsByCategory).toEqual({ tone: 2, factual_error: 1 });
    expect(a.pending).toBe(1);
    expect(a.decided).toBe(16);
    expect(a.approvalRate).toBeCloseTo(13 / 16);
    expect(a.medianEditRatioOfEdited).toBeCloseTo(0.1);
    expect(a.medianEditRatio).toBe(0); // scorecard definition: 10 unedited zeros dominate
    expect(a.lintErrors).toBe(1);
    expect(a.medianReviewMinutes).not.toBeNull();
    expect(a.criteria.map((k) => k.code)).toEqual(["decided", "approval_rate", "edit_ratio", "compliance", "lint_rate"]);
    expect(a.promotionEligible).toBe(false); // 16 < 30 decided
    // 13/16 = 81% < 85% on a 16-decision sample -> below the bar
    expect(a.verdict.status).toBe("below_bar");
    expect(a.verdict.reason).toContain("approval rate 81.3% < 85%");
    expect(st.totals).toMatchObject({ drafts: 17, approvedUnchanged: 10, approvedEdited: 3, rejected: 3, pending: 1 });
  });

  it("daily rows sum to the totals and day 1 is the first 24h", () => {
    const { db, run } = seedRun();
    const st = computeShadowStatus(db, run);
    expect(st.daily).toHaveLength(6);
    expect(st.daily[0]!.day).toBe(1);
    const sum = (k: "drafts" | "approvedUnchanged" | "approvedEdited" | "rejected") => st.daily.reduce((n, d) => n + d[k], 0);
    expect(sum("drafts")).toBe(st.totals.drafts);
    expect(sum("approvedUnchanged")).toBe(st.totals.approvedUnchanged);
    expect(sum("approvedEdited")).toBe(st.totals.approvedEdited);
    expect(sum("rejected")).toBe(st.totals.rejected);
    expect(st.agents[0]!.daily.map((d) => d.drafts)).toEqual(st.daily.map((d) => d.drafts));
  });

  it("returns nulls, not zeros, when there is no data, and counts needs_human escalations", () => {
    const t = setup();
    addAgent(t.db, "sdr-01");
    const run = t.db.shadowRuns.create({ plannedDays: 14, agentIds: ["sdr-01"] });
    const st = computeShadowStatus(t.db, run);
    const a = st.agents[0]!;
    expect(a).toMatchObject({ drafts: 0, decided: 0, approvalRate: null, medianEditRatio: null, medianEditRatioOfEdited: null, lintErrorRate: null, medianReviewMinutes: null, needsHuman: 0 });
    expect(a.verdict.status).toBe("not_enough_data");
    expect(st.totals.oldestPendingAt).toBeNull();

    const task = t.db.tasks.create({ agentId: "sdr-01", kind: "sdr.handle_reply", title: "t", input: {} });
    t.db.tasks.transition(task.id, "running");
    t.db.tasks.transition(task.id, "waiting_approval", { result: { status: "needs_human", summary: "x", data: {} } as never });
    expect(computeShadowStatus(t.db, run).agents[0]!.needsHuman).toBe(1);
  });

  it("an ended run is frozen at its end and flagged complete once the planned length passed", () => {
    const t = setup();
    addAgent(t.db, "sdr-01");
    const run = t.db.shadowRuns.create({ plannedDays: 7, agentIds: ["sdr-01"], startedAt: new Date(Date.now() - 20 * DAY).toISOString() });
    expect(computeShadowStatus(t.db, run)).toMatchObject({ day: 21, complete: true, daysRemaining: 0, active: true });
    const ended = t.db.shadowRuns.end(run.id, { endedAt: new Date(Date.now() - 12 * DAY).toISOString() });
    expect(computeShadowStatus(t.db, ended)).toMatchObject({ day: 9, active: false, complete: true });
  });
});

describe("shadow admin routes", () => {
  it("refuses to start with no shadow agents, with a non-shadow agent, or twice; ends once", async () => {
    const { db, call, events } = setup();
    expect((await call("POST", "/v1/admin/shadow", {})).status).toBe(400); // no agents at all

    addAgent(db, "sdr-01", "assisted");
    const bad = await call("POST", "/v1/admin/shadow", { agentIds: ["sdr-01"] });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("assisted tier");
    expect((await call("POST", "/v1/admin/shadow", { agentIds: ["ghost"] })).status).toBe(400);
    expect((await call("POST", "/v1/admin/shadow", { plannedDays: 0 })).status).toBe(400);

    addAgent(db, "sdr-02", "shadow");
    const started = await call("POST", "/v1/admin/shadow", { notes: "pilot" });
    expect(started.status).toBe(200);
    const run = started.json.data.status.run;
    expect(run).toMatchObject({ plannedDays: 14, agentIds: ["sdr-02"], notes: "pilot", endedAt: null }); // sdr-01 is assisted -> not a default candidate
    expect(started.json.data.status).toMatchObject({ day: 1, active: true });
    expect(db.audit.list({ kind: ["shadow.started"] })).toHaveLength(1);
    expect(events.some((e) => e.type === "shadow.updated")).toBe(true);

    expect((await call("POST", "/v1/admin/shadow", {})).status).toBe(409);

    const overview = await call("GET", "/v1/admin/shadow");
    expect(overview.json.data.active.run.id).toBe(run.id);
    expect(overview.json.data.last).toBeNull();
    expect(overview.json.data.candidates).toEqual([{ agentId: "sdr-02", displayName: "sdr-02", role: "sales-sdr" }]);

    const ended = await call("POST", `/v1/admin/shadow/${run.id}/end`, { notes: "done" });
    expect(ended.status).toBe(200);
    expect(ended.json.data.status).toMatchObject({ active: false, run: { notes: "done" } });
    expect(db.audit.list({ kind: ["shadow.ended"] })).toHaveLength(1);
    expect((await call("POST", `/v1/admin/shadow/${run.id}/end`, {})).status).toBe(409);
    expect((await call("POST", "/v1/admin/shadow/nope/end", {})).status).toBe(404);

    const after = await call("GET", "/v1/admin/shadow");
    expect(after.json.data.active).toBeNull();
    expect(after.json.data.last.run.id).toBe(run.id);
    expect((await call("GET", `/v1/admin/shadow/${run.id}`)).json.data.status.run.id).toBe(run.id);
    expect((await call("GET", "/v1/admin/shadow/nope")).status).toBe(404);
  });

  it("does not default to chief-of-staff agents", async () => {
    const { db, call } = setup();
    db.agents.create({ id: "cos-01", role: "chief-of-staff", displayName: "Khoa", model: "m", workspacePath: "/tmp/cos", policy: { builtins: [], mcp: [] } });
    expect((await call("POST", "/v1/admin/shadow", {})).status).toBe(400);
  });
});

describe("shadow section of the daily digest", () => {
  it("is null with no active run", () => {
    const t = setup();
    expect(buildDigestSnapshot(t.db, new Date(Date.now() - DAY), new Date()).shadowRun).toBeNull();
  });

  it("reports progress, the period's decisions, backlog, oldest draft and agents below the bar", () => {
    const { db } = seedRun();
    const now = new Date();
    const section = buildShadowDigest(db, new Date(now.getTime() - 0.9 * DAY), now)!;
    expect(section).toMatchObject({ day: 6, plannedDays: 14, daysRemaining: 9, complete: false, pendingDrafts: 1 });
    // decisions in the last 21.6h: the 0.5-day-old rejection only (the others were decided >= 1 day ago)
    expect(section.period).toMatchObject({ approvedUnchanged: 0, approvedEdited: 0, rejected: 1 });
    expect(section.oldestUnreviewed).toMatchObject({ agentId: "sdr-01" });
    expect(section.oldestUnreviewed!.ageHours).toBeGreaterThan(29);
    expect(section.pilingUp).toBe(true); // oldest waited more than a day
    expect(section.agentsBelowBar.map((a) => a.agentId)).toEqual(["sdr-01"]);
    expect(section.agents[0]).toMatchObject({ agentId: "sdr-01", verdict: "below_bar" });

    const viaSnapshot = buildDigestSnapshot(db, new Date(now.getTime() - DAY), now).shadowRun;
    expect(viaSnapshot?.runId).toBe(section.runId);
  });

  it("is not piling up with a short, fresh queue", () => {
    const t = setup();
    addAgent(t.db, "sdr-01");
    t.db.shadowRuns.create({ plannedDays: 14, agentIds: ["sdr-01"], startedAt: new Date(Date.now() - DAY).toISOString() });
    seedDraft(t.db, "sdr-01", { status: "pending_approval", daysAgo: 0.1 });
    const s = buildShadowDigest(t.db, new Date(Date.now() - DAY), new Date())!;
    expect(s).toMatchObject({ pendingDrafts: 1, pilingUp: false, day: 2 });
    expect(s.agentsBelowBar).toEqual([]);
  });
});

describe("chief-of-staff digest evals match the real snapshot shape", () => {
  const evalsDir = path.resolve(__dirname, "../../../templates/chief-of-staff/evals");
  const keys = (o: unknown) => Object.keys(o as object).sort();

  it("every daily-digest case has the keys buildDigestSnapshot produces (shadowRun included)", () => {
    const { db } = seedRun();
    const real = buildDigestSnapshot(db, new Date(Date.now() - DAY), new Date());
    const idle = buildDigestSnapshot(setup().db, new Date(Date.now() - DAY), new Date());
    const cases = fs.readdirSync(evalsDir).filter((f) => f.endsWith(".json") && f !== "suite.json");
    const digests = cases.map((f) => JSON.parse(fs.readFileSync(path.join(evalsDir, f), "utf8"))).filter((c) => c.kind === "cos.daily_digest");
    expect(digests.length).toBeGreaterThanOrEqual(2);
    for (const c of digests) {
      const snap = c.input.snapshot;
      expect(keys(snap), c.id).toEqual(keys(real));
      expect(keys(snap.kpis), c.id).toEqual(keys(real.kpis));
      if (snap.shadowRun === null) expect(idle.shadowRun).toBeNull();
      else {
        expect(keys(snap.shadowRun), c.id).toEqual(keys(real.shadowRun));
        expect(keys(snap.shadowRun.period), c.id).toEqual(keys(real.shadowRun!.period));
        expect(keys(snap.shadowRun.oldestUnreviewed), c.id).toEqual(keys(real.shadowRun!.oldestUnreviewed));
        expect(keys(snap.shadowRun.agents[0]), c.id).toEqual(keys(real.shadowRun!.agents[0]));
        expect(keys(snap.shadowRun.agentsBelowBar[0]), c.id).toEqual(keys(real.shadowRun!.agentsBelowBar[0]));
      }
    }
  });

  it("the shadow case's assertions accept a plausible digest and reject an invented percentage", () => {
    const c = JSON.parse(fs.readFileSync(path.join(evalsDir, "07-daily-digest-shadow-run-backlog.json"), "utf8"));
    const pats = c.assertions.filter((a: { type: string }) => a.type === "result.data.path");
    const good = [
      "# Bản tin 01/10",
      "",
      "## Cần xử lý hôm nay",
      "1. Duyệt 14 bản nháp shadow đang chờ — cũ nhất đã chờ 31.5 giờ (kinhdoanh@minhphat.example).",
      "",
      "## Đã diễn ra",
      "- Shadow run ngày 6/14: 9 duyệt nguyên bản, 3 duyệt có sửa, 2 từ chối.",
      "",
      "## Rủi ro / lưu ý",
      "- Mai dưới ngưỡng: tỷ lệ duyệt 71.4% < 85% (14 bản đã quyết định).",
    ].join("\n");
    const check = (md: string) =>
      pats.every((a: { pattern?: string; notPattern?: string; exists?: boolean }) => {
        if (a.pattern) return new RegExp(a.pattern).test(md);
        if (a.notPattern) return !new RegExp(a.notPattern).test(md);
        return true;
      });
    expect(check(good)).toBe(true);
    expect(check(good + "\n- Tỷ lệ duyệt chung khoảng 80%.")).toBe(false);
    expect(check(good.replace("Duyệt 14 bản nháp", "Duyệt các bản nháp"))).toBe(false);
  });
});
