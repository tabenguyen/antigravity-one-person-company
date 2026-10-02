import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { cmdBriefings, cmdKpis, kpiRows } from "../src/commands/coordination.ts";
import { parseRoutineCreateArgs } from "../src/commands/routines.ts";

const report = {
  windowDays: 7,
  roles: {
    "sales-sdr": { agents: 1, leadsResearched: 3, firstTouchDrafted: 2, emailsSent: 0, replies: 0, replyRate: null, qualified: 1, meetingsBooked: 0, handoffs: 1 },
    "account-manager": { agents: 1, accounts: 4, messagesHandled: 2, medianFirstResponseMinutes: 42.34, escalations: 1, checkInsDrafted: 0, churned: 0 },
    "chief-of-staff": { agents: 0, triaged: 0, delegated: 0, escalated: 0, digests: 0 },
  },
  common: { tasksDone: 9, tasksFailed: 0, needsHuman: 1, approvalRate: 0.875, medianEditRatio: null },
};
const briefing = { id: "brf_1", agentId: "cos-01", taskId: "tsk_1", periodStart: "2026-10-01T01:00:00.000Z", periodEnd: "2026-10-02T01:00:00.000Z", markdown: "# Bản tin\n\nHôm nay ổn.", createdAt: "2026-10-02T01:05:00.000Z" };

describe("hq kpis / briefings", () => {
  let server: ServerType;
  let url: string;
  const requests: string[] = [];

  beforeAll(async () => {
    const app = new Hono();
    app.get("/v1/admin/kpis", (c) => {
      requests.push(c.req.url);
      return c.json({ ok: true, data: report });
    });
    app.get("/v1/admin/briefings", (c) => {
      requests.push(c.req.url);
      return c.json({ ok: true, data: { briefings: [briefing] } });
    });
    app.get("/v1/admin/briefings/:id", (c) => c.json({ ok: true, data: { briefing } }));
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

  const globals = () => ({ json: false, url, token: "t", cwd: fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-cli-c-")) });
  function capture() {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    return out;
  }

  it("kpiRows shows '-' for null rates and medians, never 0", () => {
    const rows = kpiRows(report as never);
    const val = (role: string, metric: string) => rows.find((r) => r.role === role && r.metric === metric)!.value;
    expect(val("sales-sdr", "replyRate")).toBe("-");
    expect(val("sales-sdr", "emailsSent")).toBe("0");
    expect(val("account-manager", "medianFirstResponseMinutes")).toBe("42.3");
    expect(val("common", "approvalRate")).toBe("87.5%");
    expect(val("common", "medianEditRatio")).toBe("-");
  });

  it("kpis passes --days and prints the table", async () => {
    const out = capture();
    await cmdKpis(["--days", "30"], globals());
    expect(requests[0]).toContain("days=30");
    expect(out.join("\n")).toContain("window: last 7 days");
    expect(out.join("\n")).toContain("replyRate");
  });

  it("briefings list / show", async () => {
    const out = capture();
    await cmdBriefings(["list", "--limit", "5"], globals());
    expect(requests[0]).toContain("limit=5");
    expect(out.join("\n")).toContain("brf_1");
    out.length = 0;
    await cmdBriefings(["show", "brf_1"], globals());
    expect(out.join("\n")).toContain("# Bản tin");
  });

  it("routine create accepts the new kinds", () => {
    expect(parseRoutineCreateArgs(["--agent", "am-01", "--kind", "account_review", "--name", "n", "--schedule", "0 9 * * 1"]).body.kind).toBe("account_review");
    expect(parseRoutineCreateArgs(["--agent", "cos-01", "--kind", "daily_digest", "--name", "n", "--schedule", "0 8 * * *", "--config", '{"lookbackHours":12}']).body.config).toEqual({ lookbackHours: 12 });
  });
});
