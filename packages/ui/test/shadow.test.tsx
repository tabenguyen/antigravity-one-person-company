// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ShadowPage } from "../src/pages/Shadow/ShadowPage.tsx";
import { ShadowCard } from "../src/pages/Shadow/ShadowCard.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { ok, installMockEventSource } from "./testUtils.ts";

const criteria = { minDecided: 30, minApprovalRate: 0.85, maxMedianEditRatio: 0.15, maxComplianceRejections: 0, maxLintErrorsRate: 0.05 };
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

function agent(over: Record<string, unknown> = {}) {
  return {
    agentId: "sdr-01",
    displayName: "Mai",
    role: "sales-sdr",
    trustTier: "shadow",
    agentStatus: "active",
    drafts: 18,
    pending: 3,
    oldestPendingAt: iso(1.5),
    decided: 14,
    approvedUnchanged: 8,
    approvedEdited: 3,
    medianEditRatioOfEdited: 0.12,
    medianEditRatio: 0.04,
    approvalRate: 11 / 14,
    rejected: 3,
    rejectionsByCategory: { tone: 2, factual_error: 1 },
    lintErrors: 1,
    lintErrorRate: 0.05,
    needsHuman: 2,
    medianReviewMinutes: 42,
    criteria: [
      { code: "decided", label: "Decided drafts", value: 14, target: 30, op: ">=", status: "unmet", message: "x" },
      { code: "approval_rate", label: "Approval rate", value: 11 / 14, target: 0.85, op: ">=", status: "unmet", message: "x" },
      { code: "edit_ratio", label: "Median edit ratio", value: 0.04, target: 0.15, op: "<=", status: "met", message: null },
      { code: "compliance", label: "Compliance rejections", value: 0, target: 0, op: "<=", status: "met", message: null },
      { code: "lint_rate", label: "Lint error rate", value: null, target: 0.05, op: "<=", status: "no_data", message: null },
    ],
    promotionEligible: false,
    verdict: { status: "below_bar", reason: "approval rate 78.6% < 85% (14 decided drafts so far)" },
    daily: [
      { day: 1, startAt: iso(2), drafts: 10, approvedUnchanged: 4, approvedEdited: 1, rejected: 1 },
      { day: 2, startAt: iso(1), drafts: 8, approvedUnchanged: 4, approvedEdited: 2, rejected: 2 },
    ],
    ...over,
  };
}

function status(over: Record<string, unknown> = {}) {
  const a = agent();
  return {
    run: { id: "shd_1", startedAt: iso(1.5), plannedDays: 14, agentIds: ["sdr-01"], notes: "pilot", endedAt: null },
    active: true,
    day: 2,
    plannedDays: 14,
    daysRemaining: 12,
    complete: false,
    endsAt: iso(-12.5),
    asOf: new Date().toISOString(),
    criteria,
    agents: [a],
    totals: { drafts: 18, approvedUnchanged: 8, approvedEdited: 3, rejected: 3, pending: 3, oldestPendingAt: iso(1.5) },
    daily: a.daily,
    ...over,
  };
}

const CANDIDATES = [
  { agentId: "sdr-01", displayName: "Mai", role: "sales-sdr" },
  { agentId: "am-01", displayName: "Linh", role: "account-manager" },
];

function mount(ui: React.ReactElement, overview: Record<string, unknown>) {
  installMockEventSource();
  localStorage.setItem("agyhq_admin_token", "t");
  const calls: { method: string; path: string; body?: any }[] = [];
  let current = overview;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname === "/v1/admin/shadow") return ok(current);
    if (method === "POST" && url.pathname === "/v1/admin/shadow") {
      current = { ...current, active: status({ run: { id: "shd_new", startedAt: new Date().toISOString(), plannedDays: body.plannedDays, agentIds: body.agentIds, notes: body.notes ?? null, endedAt: null } }) };
      return ok({ status: (current as any).active });
    }
    if (method === "POST" && /\/end$/.test(url.pathname)) {
      current = { ...current, active: null, last: status({ active: false }) };
      return ok({ status: (current as any).last });
    }
    throw new Error(`No mock route for ${method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
  );
  return { calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Dashboard shadow card", () => {
  it("shows day N of M and a verdict with its reason per agent", async () => {
    mount(<ShadowCard />, { active: status(), last: null, history: [], candidates: CANDIDATES });
    await screen.findByText("Day 2 of 14");
    expect(screen.getByText("Below bar")).toBeTruthy();
    expect(screen.getByText(/approval rate 78.6% < 85%/)).toBeTruthy();
    expect(screen.getByText(/3 waiting/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /details/i }).getAttribute("href")).toBe("/shadow");
  });

  it("invites you to start a run when none exists", async () => {
    mount(<ShadowCard />, { active: null, last: null, history: [], candidates: CANDIDATES });
    await screen.findByText("Not running");
    expect(screen.getByRole("link", { name: /start a shadow run/i }).getAttribute("href")).toBe("/shadow");
  });
});

describe("Shadow page", () => {
  it("shows the per-agent breakdown, criteria progress, rejection reasons and the daily trend", async () => {
    mount(<ShadowPage />, { active: status(), last: null, history: [status().run], candidates: CANDIDATES });
    const section = await screen.findByLabelText("Shadow results sdr-01");
    expect(within(section).getByText("Below bar")).toBeTruthy();
    expect(within(section).getByLabelText("Approved unchanged").textContent).toContain("8");
    expect(within(section).getByLabelText("Approved with edits").textContent).toContain("median edit 12%");
    expect(within(section).getByLabelText("Needs-human escalations").textContent).toContain("2");
    expect(within(section).getByLabelText("Median time to review").textContent).toContain("42 min");
    expect(within(section).getByLabelText("Lint error rate").getAttribute("data-tone")).toBe("none");
    expect(within(section).getByLabelText("Median edit ratio").getAttribute("data-tone")).toBe("ok");
    expect(within(section).getByLabelText("Approval rate").getAttribute("data-tone")).toBe("bad");
    expect(within(section).getByText("Tone")).toBeTruthy();
    expect(screen.getByLabelText("Daily trend").textContent).toContain("Daily trend");
    expect(screen.getByText(/3 drafts waiting for review/)).toBeTruthy();
  });

  it("starts a run through a confirm dialog with length, agents and notes", async () => {
    const { calls } = mount(<ShadowPage />, { active: null, last: null, history: [], candidates: CANDIDATES });
    fireEvent.click(await screen.findByRole("button", { name: "Start shadow run" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing happens before confirming
    fireEvent.change(within(dialog).getByLabelText(/length/i), { target: { value: "7" } });
    fireEvent.click(within(dialog).getByLabelText(/Linh/)); // untick one agent
    fireEvent.change(within(dialog).getByLabelText(/notes/i), { target: { value: "pilot" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start shadow run" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ plannedDays: 7, agentIds: ["sdr-01"], notes: "pilot" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("ends a run only after confirming, and keeps the result visible", async () => {
    const { calls } = mount(<ShadowPage />, { active: status(), last: null, history: [status().run], candidates: CANDIDATES });
    fireEvent.click(await screen.findByRole("button", { name: "End shadow run" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.path.endsWith("/end"))).toBe(false);
    expect(dialog.textContent).toMatch(/does not change any agent.s trust tier/); // promotion stays a separate decision
    fireEvent.click(within(dialog).getByRole("button", { name: "End shadow run" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/admin/shadow/shd_1/end")).toBe(true));
    await screen.findByRole("button", { name: "Start shadow run" });
    expect(screen.getByLabelText("Shadow results sdr-01")).toBeTruthy(); // last result stays
  });

  it("says when the planned length is over", async () => {
    mount(<ShadowPage />, { active: status({ complete: true, day: 15, daysRemaining: 0 }), last: null, history: [], candidates: CANDIDATES });
    await screen.findByText(/planned 14 days are over/);
  });
});
