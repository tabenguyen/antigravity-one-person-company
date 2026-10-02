// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "../src/pages/Dashboard/DashboardPage.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { ok, installMockEventSource } from "./testUtils.ts";

const STATUS = {
  version: "1.2.3",
  startedAt: new Date().toISOString(),
  agyVersion: "1.2.14",
  email: { provider: "imap-smtp", address: "sdr@acme.com", ok: true, error: null, lastPollAt: null, lastSendAt: null },
  outboundEnabled: false,
  outboundDisabledReason: "not yet enabled",
  inQuietHours: false,
  quotaThrottled: false,
  runningTasks: 0,
};

function setup() {
  installMockEventSource();
  setLocalToken();

  const killRequests: unknown[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (method === "GET" && path === "/v1/admin/status") return ok({ status: STATUS });
    if (method === "GET" && path === "/v1/admin/stats") return ok({ days: 7, agents: [], inboundToday: 0, sentToday: 0 });
    if (method === "GET" && path === "/v1/admin/quota") return ok({ at: new Date().toISOString(), buckets: [] });
    if (method === "POST" && path === "/v1/admin/killswitch") {
      killRequests.push(JSON.parse(String(init?.body)));
      return ok({ settings: {} });
    }
    throw new Error(`No mock route for ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const utils = render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <DashboardPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { ...utils, killRequests };
}

function setLocalToken() {
  localStorage.setItem("agyhq_admin_token", "test-token");
}

describe("Dashboard kill switch", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("requires a confirm step before enabling outbound, and calls the killswitch endpoint on confirm", async () => {
    const { killRequests } = setup();

    await waitFor(() => expect(screen.getByRole("button", { name: /enable outbound/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /enable outbound/i }));

    // Confirm dialog should appear; the request must not fire until confirmed.
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(killRequests).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^enable$/i }));

    await waitFor(() => expect(killRequests).toHaveLength(1));
    expect(killRequests[0]).toMatchObject({ outboundEnabled: true });
  });

  it("lets the operator cancel out of the confirm dialog without sending a request", async () => {
    const { killRequests } = setup();

    await waitFor(() => expect(screen.getByRole("button", { name: /enable outbound/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /enable outbound/i }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(killRequests).toHaveLength(0);
  });
});
