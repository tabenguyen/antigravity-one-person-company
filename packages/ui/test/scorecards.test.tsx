// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ScorecardsPage } from "../src/pages/Scorecards/ScorecardsPage.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { fail, installMockEventSource, ok } from "./testUtils.ts";

const CRITERIA = { minDecided: 30, minApprovalRate: 0.85, maxMedianEditRatio: 0.15, maxComplianceRejections: 0, maxLintErrorsRate: 0.05 };

function card(over: Record<string, unknown>) {
  return {
    agentId: "sdr-01", role: "sales-sdr", trustTier: "shadow", windowDays: 14, drafts: 40, decided: 34, approved: 31, rejected: 3,
    approvalRate: 0.91, editedRate: 0.3, medianEditRatio: 0.08, rejectionsByCategory: { tone: 2, factual_error: 1 }, lintErrorRate: 0.02,
    medianReviewMinutes: 12, sent: 0, replies: 0, replyRate: null, tasks: { done: 20, failed: 1, needsHuman: 2 },
    promotion: { nextTier: "assisted", eligible: true, unmet: [] }, ...over,
  };
}

const NOT_ELIGIBLE = card({
  agentId: "sdr-02", decided: 8, approved: 5, rejected: 3, approvalRate: 0.62, medianEditRatio: 0.3, rejectionsByCategory: { compliance: 1, tone: 2 },
  lintErrorRate: 0.1, promotion: { nextTier: "assisted", eligible: false, unmet: ["decided drafts 8 < 30", "approval rate 62% < 85%"] },
});

function setup(cards: unknown[] = [card({})], opts: { promoteError?: string } = {}) {
  installMockEventSource();
  const calls: { method: string; path: string; query: string; body: any }[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.search, body });
    if (method === "GET" && url.pathname === "/v1/admin/scorecards") {
      return ok({ days: Number(url.searchParams.get("days")), criteria: CRITERIA, scorecards: cards });
    }
    if (method === "GET" && url.pathname === "/v1/admin/agents") {
      return ok({ agents: [{ id: "sdr-01", displayName: "Mai the SDR", trustTier: "shadow", role: "sales-sdr" }] });
    }
    if (method === "PUT" && url.pathname === "/v1/admin/promotion-criteria") return ok({ criteria: { ...CRITERIA, ...body } });
    if (method === "POST" && /\/promote$/.test(url.pathname)) {
      if (opts.promoteError) return fail("conflict", opts.promoteError, 409);
      return ok({ agent: { id: "x", trustTier: "assisted" } });
    }
    throw new Error(`No mock route for ${method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <ScorecardsPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { calls };
}

const section = (name: RegExp) => screen.findByRole("region", { name });

describe("Scorecards page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a card per agent with tier badge, metrics against thresholds, and rejection breakdown", async () => {
    setup([card({}), NOT_ELIGIBLE]);
    const first = await section(/Scorecard sdr-01/);
    expect(within(first).getByText("Mai the SDR")).toBeTruthy(); // display name from the agents list
    expect(within(first).getByLabelText("Trust tier").textContent).toBe("shadow");

    const approval = within(first).getByLabelText("Approval rate");
    expect(approval.textContent).toContain("91%");
    expect(approval.textContent).toContain("need ≥ 85%");
    expect(approval.getAttribute("data-tone")).toBe("ok");
    expect(within(first).getByLabelText("Decided drafts").getAttribute("data-tone")).toBe("ok");
    expect(within(first).getByLabelText("Compliance rejections").getAttribute("data-tone")).toBe("ok");

    const rejects = within(first).getByLabelText("Rejection reasons");
    expect(rejects.textContent).toContain("Tone");
    expect(rejects.textContent).toContain("Factual error");

    const second = await section(/Scorecard sdr-02/);
    expect(within(second).getByLabelText("Approval rate").getAttribute("data-tone")).toBe("bad");
    expect(within(second).getByLabelText("Median edit ratio").getAttribute("data-tone")).toBe("bad");
    expect(within(second).getByLabelText("Compliance rejections").getAttribute("data-tone")).toBe("bad");
    expect(within(second).getByLabelText("Lint error rate").getAttribute("data-tone")).toBe("bad");
    expect(within(second).getByLabelText("Decided drafts").getAttribute("data-tone")).toBe("bad");
  });

  it("shows n/a (neutral) for metrics with no data", async () => {
    setup([card({ approvalRate: null, medianEditRatio: null, lintErrorRate: null, decided: 0, rejectionsByCategory: {} })]);
    const el = await section(/Scorecard sdr-01/);
    const approval = within(el).getByLabelText("Approval rate");
    expect(approval.textContent).toContain("n/a");
    expect(approval.getAttribute("data-tone")).toBe("none");
    expect(within(el).getByText("No rejections in this window.")).toBeTruthy();
  });

  it("window selector refetches with the chosen number of days", async () => {
    const { calls } = setup();
    await section(/Scorecard sdr-01/);
    expect(calls.find((c) => c.path === "/v1/admin/scorecards")!.query).toBe("?days=14");
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/admin/scorecards" && c.query === "?days=30")).toBe(true));
    expect(screen.getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("eligible agent: Promote button -> confirm dialog explains consequences -> POST promote", async () => {
    const { calls } = setup();
    const el = await section(/Scorecard sdr-01/);
    expect(within(el).getByText("Eligible to move to assisted")).toBeTruthy();
    expect(within(el).queryByRole("button", { name: /promote anyway/i })).toBeNull();

    fireEvent.click(within(el).getByRole("button", { name: "Promote to assisted" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/will be sent for real/i);
    expect(dialog.textContent).toMatch(/still review every email/i);
    expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing happens until confirmed

    fireEvent.click(within(dialog).getByRole("button", { name: "Promote to assisted" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/admin/agents/sdr-01/promote")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({});
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText(/promoted to assisted/i)).toBeTruthy();
  });

  it("cancelling the confirm dialog does not promote", async () => {
    const { calls } = setup();
    const el = await section(/Scorecard sdr-01/);
    fireEvent.click(within(el).getByRole("button", { name: "Promote to assisted" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("ineligible agent: lists unmet criteria, no plain Promote button; 'Promote anyway' needs two confirms and sends force", async () => {
    const { calls } = setup([NOT_ELIGIBLE]);
    const el = await section(/Scorecard sdr-02/);
    expect(within(el).getByText("decided drafts 8 < 30")).toBeTruthy();
    expect(within(el).getByText("approval rate 62% < 85%")).toBeTruthy();
    expect(within(el).queryByRole("button", { name: "Promote to assisted" })).toBeNull();

    fireEvent.click(within(el).getByRole("button", { name: /promote anyway/i }));
    const first = await screen.findByRole("alertdialog");
    expect(first.textContent).toContain("approval rate 62% < 85%");
    fireEvent.click(within(first).getByRole("button", { name: "Continue" }));

    const second = await screen.findByText(/absolutely sure/i);
    expect(second).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /yes, promote anyway/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ force: true });
  });

  it("surfaces a server refusal as an error toast", async () => {
    setup([card({})], { promoteError: "agent is not eligible" });
    const el = await section(/Scorecard sdr-01/);
    fireEvent.click(within(el).getByRole("button", { name: "Promote to assisted" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Promote to assisted" }));
    expect(await screen.findByText("agent is not eligible")).toBeTruthy();
  });

  it("autonomous agents have no further promotion", async () => {
    setup([card({ trustTier: "autonomous", promotion: null })]);
    const el = await section(/Scorecard sdr-01/);
    expect(within(el).getByText(/highest trust tier/i)).toBeTruthy();
  });

  it("criteria editor: collapsible form, validates, and PUTs the changed values as fractions", async () => {
    const { calls } = setup();
    await section(/Scorecard sdr-01/);
    const summary = screen.getByText("Promotion criteria");
    expect(summary.closest("details")!.hasAttribute("open")).toBe(false);
    fireEvent.click(summary);

    fireEvent.change(screen.getByLabelText("Minimum decided drafts"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Minimum approval rate (%)"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      minDecided: 10, minApprovalRate: 0.9, maxMedianEditRatio: 0.15, maxComplianceRejections: 0, maxLintErrorsRate: 0.05,
    });
    expect(await screen.findByText("Promotion criteria saved.")).toBeTruthy();
  });

  it("criteria editor rejects out-of-range percentages without calling the API", async () => {
    const { calls } = setup();
    await section(/Scorecard sdr-01/);
    fireEvent.click(screen.getByText("Promotion criteria"));
    fireEvent.change(screen.getByLabelText("Minimum approval rate (%)"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));
    expect(await screen.findByText(/must be a valid number between 0 and 100/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
