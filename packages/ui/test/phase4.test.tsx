// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { ContactDetailPage } from "../src/pages/Contacts/ContactDetailPage.tsx";
import { SettingsPage } from "../src/pages/Settings/SettingsPage.tsx";
import { RoutineForm } from "../src/pages/Routines/RoutineForm.tsx";
import { CreateAgentForm } from "../src/pages/Agents/CreateAgentForm.tsx";
import { BriefingsPage } from "../src/pages/Briefings/BriefingsPage.tsx";
import { KpiGroups, fmtMinutes } from "../src/pages/Dashboard/KpiSection.tsx";
import { TaskInsights } from "../src/pages/Tasks/TaskInsights.tsx";
import { ok, fail, installMockEventSource } from "./testUtils.ts";

const agent = (id: string, role: string, over: Record<string, unknown> = {}) => ({
  id,
  role,
  displayName: id.toUpperCase(),
  status: "active",
  trustTier: "shadow",
  model: "m",
  ...over,
});
const AGENTS = [agent("sdr-01", "sales-sdr"), agent("am-01", "account-manager"), agent("cos-01", "chief-of-staff"), agent("am-old", "account-manager", { status: "paused" })];

const settings = (over: Record<string, unknown> = {}) => ({
  outboundEnabled: false,
  outboundDisabledReason: null,
  quietHours: null,
  sendRatePerHour: 30,
  autoTrip: { windowSize: 50, maxBounceRate: 0.05 },
  defaultSdrAgentId: "sdr-01",
  defaultAmAgentId: null,
  defaultCosAgentId: null,
  autonomousRequiresPriorApproval: true,
  ...over,
});

const contact = (over: Record<string, unknown> = {}) => ({
  id: "con_1",
  email: "an@acme.example",
  name: "An Nguyen",
  title: null,
  phone: null,
  companyId: null,
  company: null,
  language: "vi",
  stage: "qualified",
  ownerAgentId: "sdr-01",
  source: null,
  attributes: {},
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  recentNotes: [],
  ...over,
});

interface Ctx {
  settings: ReturnType<typeof settings>;
  contact: ReturnType<typeof contact>;
  audit: unknown[];
  calls: { method: string; path: string; body: any }[];
}

function mockApi(ctx: Ctx) {
  installMockEventSource();
  localStorage.setItem("agyhq_admin_token", "t");
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") ctx.calls.push({ method, path, body });
    if (path === "/v1/admin/status") return ok({ status: { version: "1", startedAt: "", agyVersion: "1", email: { provider: "x", address: null, ok: true, error: null, lastPollAt: null, lastSendAt: null }, outboundEnabled: false, outboundDisabledReason: null, inQuietHours: false, quotaThrottled: false, runningTasks: 0 } });
    if (method === "GET" && path === "/v1/admin/settings") return ok({ settings: ctx.settings });
    if (method === "PATCH" && path === "/v1/admin/settings") {
      if (body.defaultAmAgentId === "am-old") return fail("invalid_request", "defaultAmAgentId: am-old is not an active account-manager agent", 400);
      Object.assign(ctx.settings, body);
      return ok({ settings: ctx.settings });
    }
    if (method === "GET" && path === "/v1/admin/agents") return ok({ agents: AGENTS });
    if (method === "GET" && path === "/v1/admin/contacts/con_1") return ok({ contact: ctx.contact, timeline: [] });
    if (method === "GET" && path === "/v1/admin/audit") return ok({ events: ctx.audit });
    if (method === "POST" && path === "/v1/admin/contacts/con_1/handoff") {
      ctx.contact = contact({ stage: "customer", ownerAgentId: "am-01" });
      return ok({ contact: ctx.contact, task: { id: "tsk_1" }, fromAgentId: "sdr-01", toAgentId: "am-01" });
    }
    if (method === "GET" && path === "/v1/admin/briefings") return ok({ briefings: [] });
    if (method === "GET" && path === "/v1/admin/routines") return ok({ routines: [] });
    if (method === "POST" && path === "/v1/admin/routines") return ok({ routine: { id: "rtn_1", ...body } });
    throw new Error(`No mock route for ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const wrap = (node: React.ReactNode, route = "/") => (
  <MemoryRouter initialEntries={[route]}>
    <AuthProvider>
      <ToastProvider>{node}</ToastProvider>
    </AuthProvider>
  </MemoryRouter>
);

function newCtx(over: Partial<Ctx> = {}): Ctx {
  return { settings: settings(), contact: contact(), audit: [], calls: [], ...over };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Contact handoff", () => {
  const page = () =>
    wrap(
      <Routes>
        <Route path="/contacts/:id" element={<ContactDetailPage />} />
      </Routes>,
      "/contacts/con_1",
    );

  it("is disabled with an explanation when no default Account Manager is set", async () => {
    mockApi(newCtx());
    render(page());
    const btn = (await screen.findByRole("button", { name: "Hand off to Account Manager" })) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/No default Account Manager is set/)).toBeTruthy());
    expect(btn.disabled).toBe(true);
  });

  it("is disabled when an Account Manager already owns the contact", async () => {
    mockApi(newCtx({ settings: settings({ defaultAmAgentId: "am-01" }), contact: contact({ stage: "customer", ownerAgentId: "am-01" }) }));
    render(page());
    await waitFor(() => expect(screen.getByText(/Already owned by an Account Manager/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Hand off to Account Manager" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms with an optional summary and POSTs the handoff", async () => {
    const ctx = newCtx({ settings: settings({ defaultAmAgentId: "am-01" }) });
    mockApi(ctx);
    render(page());
    const btn = (await screen.findByRole("button", { name: "Hand off to Account Manager" })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    fireEvent.change(await screen.findByLabelText(/Summary for the Account Manager/), { target: { value: "Signed the annual plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Hand off" }));
    await waitFor(() =>
      expect(ctx.calls).toContainEqual({ method: "POST", path: "/v1/admin/contacts/con_1/handoff", body: { summary: "Signed the annual plan" } }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("shows handoff history from the audit trail", async () => {
    const ctx = newCtx({
      settings: settings({ defaultAmAgentId: "am-01" }),
      contact: contact({ stage: "customer", ownerAgentId: "am-01" }),
      audit: [
        { id: "a1", at: "2026-10-02T01:00:00Z", kind: "contact.handoff", agentId: null, taskId: null, conversationId: null, data: { contactId: "con_1", fromAgentId: "sdr-01", toAgentId: "am-01", by: "human", summary: "Won the deal" } },
        { id: "a2", at: "2026-10-02T01:00:00Z", kind: "contact.handoff", agentId: null, taskId: null, conversationId: null, data: { contactId: "con_other", fromAgentId: null, toAgentId: "am-01", summary: "x" } },
      ],
    });
    mockApi(ctx);
    render(page());
    expect(await screen.findByText("Won the deal")).toBeTruthy();
    expect(screen.queryByText("x")).toBeNull();
  });
});

describe("Settings defaults", () => {
  it("offers only active agents of the right role and saves them", async () => {
    const ctx = newCtx();
    mockApi(ctx);
    render(wrap(<SettingsPage />));
    const am = (await screen.findByLabelText(/Default Account Manager/)) as HTMLSelectElement;
    await waitFor(() => expect(within(am).queryByText(/AM-01/)).toBeTruthy());
    const options = Array.from(am.options).map((o) => o.value);
    expect(options).toEqual(["", "am-01"]); // paused am-old, sdr and cos are not offered
    const cos = screen.getByLabelText(/Default Chief of Staff/) as HTMLSelectElement;
    expect(Array.from(cos.options).map((o) => o.value)).toEqual(["", "cos-01"]);

    fireEvent.change(am, { target: { value: "am-01" } });
    fireEvent.change(cos, { target: { value: "cos-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => {
      const call = ctx.calls.find((c) => c.method === "PATCH");
      expect(call?.body).toMatchObject({ defaultAmAgentId: "am-01", defaultCosAgentId: "cos-01", defaultSdrAgentId: "sdr-01" });
    });
  });

  it("shows the backend validation error", async () => {
    mockApi(newCtx({ settings: settings({ defaultAmAgentId: "am-old" }) }));
    render(wrap(<SettingsPage />));
    await screen.findByLabelText(/Default Account Manager/);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/am-old is not an active account-manager agent/)).toBeTruthy();
  });
});

describe("Routine form (Phase 4 kinds)", () => {
  it("creates an account_review routine for an Account Manager with its config", async () => {
    const ctx = newCtx();
    mockApi(ctx);
    const onSaved = vi.fn();
    render(wrap(<RoutineForm agents={AGENTS as never} onClose={() => {}} onSaved={onSaved} />));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "account_review" } });
    const agentSelect = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect(Array.from(agentSelect.options).map((o) => o.value)).toEqual(["am-01", "am-old"]);
    expect(agentSelect.value).toBe("am-01");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly review" } });
    fireEvent.change(screen.getByLabelText(/Max accounts/), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/Stale after/), { target: { value: "21" } });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(ctx.calls[0]?.body).toMatchObject({ agentId: "am-01", kind: "account_review", config: { maxAccounts: 25, staleAfterDays: 21 } });
  });

  it("creates a daily_digest routine for the Chief of Staff and validates the look-back window", async () => {
    const ctx = newCtx();
    mockApi(ctx);
    const onSaved = vi.fn();
    render(wrap(<RoutineForm agents={AGENTS as never} onClose={() => {}} onSaved={onSaved} />));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "daily_digest" } });
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("cos-01");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning brief" } });
    fireEvent.change(screen.getByLabelText(/Look-back/), { target: { value: "1.5" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create routine" }).closest("form")!);
    expect(await screen.findByText(/Look-back must be a whole number of hours from 1 to 168/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Look-back/), { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(ctx.calls[0]?.body).toMatchObject({ agentId: "cos-01", kind: "daily_digest", config: { lookbackHours: 48 } });
  });
});

describe("Create agent form", () => {
  it("lets you pick SDR, Account Manager or Chief of Staff", async () => {
    const ctx = newCtx();
    mockApi(ctx);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: string, init?: RequestInit) => {
        ctx.calls.push({ method: "POST", path: "/v1/admin/agents", body: JSON.parse(String(init?.body)) });
        return ok({ agent: AGENTS[1] });
      }),
    );
    render(wrap(<CreateAgentForm roles={["sales-sdr", "account-manager", "chief-of-staff"]} onClose={() => {}} onCreated={() => {}} />));
    expect(screen.getByText(/Owns customers after a won deal/)).toBeTruthy();
    expect(screen.getByText(/Internal only/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Account Manager/));
    fireEvent.change(screen.getByLabelText("Id (slug)"), { target: { value: "am-02" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Lan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(ctx.calls[0]?.body).toMatchObject({ id: "am-02", role: "account-manager", displayName: "Lan" }));
  });
});

describe("Briefings empty state", () => {
  it("explains how to create a daily_digest routine for a Chief of Staff", async () => {
    mockApi(newCtx());
    render(wrap(<BriefingsPage />));
    expect(await screen.findByText("No briefings yet")).toBeTruthy();
    expect(screen.getAllByText("daily_digest", { selector: "code" }).length).toBeGreaterThan(0);
  });
});

const KPI = {
  windowDays: 7,
  roles: {
    "sales-sdr": { agents: 1, leadsResearched: 0, firstTouchDrafted: 0, emailsSent: 0, replies: 0, replyRate: null, qualified: 0, meetingsBooked: 0, handoffs: 0 },
    "account-manager": { agents: 0, accounts: 4, messagesHandled: 0, medianFirstResponseMinutes: null, escalations: 0, checkInsDrafted: 0, churned: 0 },
    "chief-of-staff": { agents: 1, triaged: 3, delegated: 2, escalated: 1, digests: 5 },
  },
  common: { tasksDone: 9, tasksFailed: 0, needsHuman: 1, approvalRate: null, medianEditRatio: 0.25 },
};

describe("KPI groups", () => {
  it("shows an em dash for null rates (never 0) and only roles that have agents", () => {
    render(<KpiGroups report={KPI as never} />);
    const sdr = screen.getByRole("region", { name: "Sales SDR" });
    expect(within(sdr.querySelector(".kpi-card:nth-child(5)") as HTMLElement).getByText("—")).toBeTruthy();
    expect(within(sdr).getByText("Reply rate")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Account Manager" })).toBeNull();
    expect(screen.getByRole("region", { name: "Chief of Staff" })).toBeTruthy();
    const common = screen.getByRole("region", { name: "All agents" });
    expect(within(common).getByText("Approval rate").parentElement?.textContent).toContain("—");
    expect(within(common).getByText("Median edit ratio").parentElement?.textContent).toContain("25%");
  });

  it("formats response times", () => {
    expect(fmtMinutes(null)).toBe("—");
    expect(fmtMinutes(12.4)).toBe("12 min");
    expect(fmtMinutes(180)).toBe("3.0 h");
  });
});

describe("Task insights", () => {
  const task = (kind: string, data: Record<string, unknown>) => ({ id: "t", kind, result: { status: "done", summary: "s", data } }) as never;
  it("renders a cos.triage decision with an assignee link", () => {
    render(
      <MemoryRouter>
        <TaskInsights
          task={task("cos.triage", { decision: { action: "delegated", assigneeAgentId: "am-01", kind: "am.handle_message", reason: "Existing customer asks about invoices" } })}
          agents={AGENTS as never}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Delegated")).toBeTruthy();
    expect((screen.getByRole("link", { name: "AM-01" }) as HTMLAnchorElement).getAttribute("href")).toBe("/tasks?agent=am-01");
    expect(screen.getByText("am.handle_message")).toBeTruthy();
    expect(screen.getByText("Existing customer asks about invoices")).toBeTruthy();
  });

  it("renders am unverified claims and urgency, and nothing for other results", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <TaskInsights task={task("am.onboard", { action: "welcome_drafted", unverifiedClaims: ["Free setup call", "10% discount"] })} agents={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Free setup call")).toBeTruthy();
    rerender(
      <MemoryRouter>
        <TaskInsights task={task("am.handle_message", { urgency: "high" })} agents={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("high")).toBeTruthy();
    rerender(
      <MemoryRouter>
        <TaskInsights task={task("sdr.handle_reply", { foo: 1 })} agents={[]} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe("");
  });
});
