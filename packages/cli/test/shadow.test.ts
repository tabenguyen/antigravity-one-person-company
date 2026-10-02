import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { cmdShadow, formatShadowStatus, shadowAgentRows } from "../src/commands/shadow.ts";

const criteria = { minDecided: 30, minApprovalRate: 0.85, maxMedianEditRatio: 0.15, maxComplianceRejections: 0, maxLintErrorsRate: 0.05 };
const status = {
  run: { id: "shd_1", startedAt: "2026-10-01T00:00:00.000Z", plannedDays: 14, agentIds: ["sdr-01"], notes: null, endedAt: null },
  active: true,
  day: 6,
  plannedDays: 14,
  daysRemaining: 9,
  complete: false,
  endsAt: "2026-10-15T00:00:00.000Z",
  asOf: "2026-10-06T12:00:00.000Z",
  criteria,
  agents: [
    {
      agentId: "sdr-01", displayName: "Mai", role: "sales-sdr", trustTier: "shadow", agentStatus: "active", drafts: 12, pending: 2, oldestPendingAt: null, decided: 10,
      approvedUnchanged: 6, approvedEdited: 2, medianEditRatioOfEdited: 0.2, medianEditRatio: 0.05, approvalRate: 0.8, rejected: 2, rejectionsByCategory: { tone: 2 },
      lintErrors: 0, lintErrorRate: 0, needsHuman: 1, medianReviewMinutes: null, criteria: [], promotionEligible: false,
      verdict: { status: "below_bar", reason: "approval rate 80% < 85% (10 decided drafts so far)" }, daily: [],
    },
  ],
  totals: { drafts: 12, approvedUnchanged: 6, approvedEdited: 2, rejected: 2, pending: 2, oldestPendingAt: null },
  daily: [{ day: 1, startAt: "2026-10-01T00:00:00.000Z", drafts: 12, approvedUnchanged: 6, approvedEdited: 2, rejected: 2 }],
};

describe("hq shadow", () => {
  let server: ServerType;
  let url: string;
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let overview: Record<string, unknown> = { active: status, last: null, history: [status.run], candidates: [] };

  beforeAll(async () => {
    const app = new Hono();
    app.all("/v1/admin/shadow", async (c) => {
      requests.push({ method: c.req.method, path: "/v1/admin/shadow", body: c.req.method === "POST" ? await c.req.json() : undefined });
      return c.json({ ok: true, data: c.req.method === "GET" ? overview : { status } });
    });
    app.all("/v1/admin/shadow/*", async (c) => {
      requests.push({ method: c.req.method, path: new URL(c.req.url).pathname, body: c.req.method === "POST" ? await c.req.json() : undefined });
      return c.json({ ok: true, data: { status } });
    });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    });
    url = `http://127.0.0.1:${port}`;
    process.env.AGYHQ_ADMIN_TOKEN = "t";
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AGYHQ_ADMIN_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    requests.length = 0;
  });

  const globals = () => ({ json: false, url, token: "t", cwd: fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-cli-s-")) });
  function capture() {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    return out;
  }

  it("formats day N of M, totals and one row per agent", () => {
    expect(formatShadowStatus(status as never)[0]).toBe("shadow run shd_1  day 6 of 14  (9 day(s) left)");
    const row = shadowAgentRows(status as never)[0]!;
    expect(row).toMatchObject({ agent: "sdr-01", verdict: "BELOW BAR", edited: "2 (med 20%)", review: "-" });
  });

  it("start sends length, agents and notes", async () => {
    const out = capture();
    await cmdShadow(["start", "--days", "7", "--agents", "sdr-01, am-01", "--notes", "pilot"], globals());
    expect(requests[0]).toEqual({ method: "POST", path: "/v1/admin/shadow", body: { plannedDays: 7, agentIds: ["sdr-01", "am-01"], notes: "pilot" } });
    expect(out.join("\n")).toContain("nothing is sent");
  });

  it("status prints the verdict with its reason; --daily adds the trend", async () => {
    const out = capture();
    await cmdShadow(["status", "--daily"], globals());
    const text = out.join("\n");
    expect(text).toContain("day 6 of 14");
    expect(text).toContain("BELOW BAR — approval rate 80% < 85%");
    expect(text).toContain("rejections: tone=2");
    expect(text).toContain("unchanged");
  });

  it("status without any run explains how to start one", async () => {
    overview = { active: null, last: null, history: [], candidates: [{ agentId: "sdr-01", displayName: "Mai", role: "sales-sdr" }] };
    const out = capture();
    await cmdShadow(["status"], globals());
    expect(out.join("\n")).toContain("hq shadow start");
    expect(out.join("\n")).toContain("sdr-01");
    overview = { active: status, last: null, history: [status.run], candidates: [] };
  });

  it("end closes the active run and reminds that promotion is separate", async () => {
    const out = capture();
    await cmdShadow(["end", "--notes", "done"], globals());
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/admin/shadow", "POST /v1/admin/shadow/shd_1/end"]);
    expect(requests[1]!.body).toEqual({ notes: "done" });
    expect(out.join("\n")).toContain("hq promote");
  });
});
