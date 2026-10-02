// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReadinessReport } from "@agyhq/core";
import { DashboardPage } from "../src/pages/Dashboard/DashboardPage.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { fail, installMockEventSource, ok, routeFetch } from "./testUtils.ts";

const STATUS = {
  version: "1.0.0",
  startedAt: new Date().toISOString(),
  agyVersion: "1.2.14",
  email: { provider: "imap-smtp", address: "mai@acme.io", ok: true, error: null, lastPollAt: null, lastSendAt: null },
  outboundEnabled: false,
  outboundDisabledReason: "not yet enabled",
  inQuietHours: false,
  quotaThrottled: false,
  runningTasks: 0,
};

const NOT_READY: ReadinessReport = {
  ready: false,
  at: new Date().toISOString(),
  checks: [
    { id: "company.profile", title: "Company profile saved", status: "fail", detail: "No company profile yet.", fixPath: "/setup#company" },
    { id: "email.verified", title: "Email connection verified", status: "fail", detail: "Connection test failed: AUTH.", fixPath: "/setup#email" },
    { id: "settings.quiet_hours", title: "Quiet hours enabled", status: "warn", detail: "Off.", fixPath: "/settings" },
  ],
};

function setup(report: ReadinessReport, killswitch: (body: any) => Response) {
  installMockEventSource();
  localStorage.setItem("agyhq_admin_token", "t");
  const kill: any[] = [];
  const fetchMock = routeFetch({
    "GET /v1/admin/status": () => ok({ status: STATUS }),
    "GET /v1/admin/stats": () => ok({ days: 7, agents: [], inboundToday: 0, sentToday: 0 }),
    "GET /v1/admin/quota": () => ok({ at: new Date().toISOString(), buckets: [] }),
    "GET /v1/admin/readiness": () => ok({ readiness: report }),
    "POST /v1/admin/killswitch": (_u, init) => {
      const body = JSON.parse(String(init?.body));
      kill.push(body);
      return killswitch(body);
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <DashboardPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { kill };
}

const CONFLICT = () => fail("conflict", "Not ready to enable outbound — 2 check(s) failing: Company profile saved; Email connection verified.", 409);

describe("Dashboard readiness", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("shows a readiness summary card linking to Setup", async () => {
    setup(NOT_READY, () => ok({ settings: {} }));
    const card = await screen.findByTestId("readiness-card");
    await within(card).findByText("Not ready");
    expect(within(card).getByText(/2 failing · 1 warning/)).toBeTruthy();
    expect(within(card).getByRole("link", { name: /open setup checklist/i }).getAttribute("href")).toBe("/setup");
  });

  it("on 409 shows the failing checks; 'Enable anyway' needs a second confirm before sending force:true", async () => {
    const { kill } = setup(NOT_READY, (body) => (body.force ? ok({ settings: { outboundEnabled: true } }) : CONFLICT()));
    fireEvent.click(await screen.findByRole("button", { name: /^enable outbound$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^enable$/i }));

    // Not-ready dialog lists failing checks (not the warning) with fix links.
    await screen.findByText("Not ready to enable outbound");
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Company profile saved")).toBeTruthy();
    expect(within(dialog).getByText("Email connection verified")).toBeTruthy();
    expect(within(dialog).queryByText("Quiet hours enabled")).toBeNull();
    expect(within(dialog).getAllByRole("link", { name: /fix/i }).map((a) => a.getAttribute("href"))).toEqual(["/setup#company", "/setup#email"]);
    expect(kill).toHaveLength(1);
    expect(kill[0].force).toBeUndefined();

    // First click only advances to the second confirmation; nothing is sent yet.
    fireEvent.click(within(dialog).getByRole("button", { name: /^enable anyway$/i }));
    await screen.findByText("Override readiness checks?");
    const second = screen.getByRole("alertdialog");
    expect(kill).toHaveLength(1);

    fireEvent.click(within(second).getByRole("button", { name: /^yes, enable anyway$/i }));
    await waitFor(() => expect(kill).toHaveLength(2));
    expect(kill[1]).toMatchObject({ outboundEnabled: true, force: true });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cancelling at either step never sends force", async () => {
    const { kill } = setup(NOT_READY, CONFLICT);
    fireEvent.click(await screen.findByRole("button", { name: /^enable outbound$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^enable$/i }));
    await screen.findByText("Not ready to enable outbound");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /^enable outbound$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^enable$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^enable anyway$/i }));
    await screen.findByText("Override readiness checks?");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await screen.findByText("Not ready to enable outbound"); // back to the not-ready dialog
    expect(kill.every((b) => !b.force)).toBe(true);
  });

  it("other errors surface as a toast, not the not-ready dialog", async () => {
    setup(NOT_READY, () => fail("internal", "db is down", 500));
    fireEvent.click(await screen.findByRole("button", { name: /^enable outbound$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^enable$/i }));
    expect(await screen.findByText("db is down")).toBeTruthy();
    expect(screen.queryByText("Not ready to enable outbound")).toBeNull();
  });
});
