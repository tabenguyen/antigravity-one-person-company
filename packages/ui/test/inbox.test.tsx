// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InboxPage } from "../src/pages/Inbox/InboxPage.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { ok } from "./testUtils.ts";

function makeOutboxItem(overrides: Record<string, unknown>) {
  return {
    id: "ob-default",
    agentId: "sdr-shadow",
    taskId: null,
    channel: "email",
    to: "lead@example.com",
    subject: "Hello",
    body: "Draft body.",
    reason: "cold outreach after research",
    threadKey: null,
    status: "pending_approval",
    originalSubject: "Hello",
    originalBody: "Draft body.",
    editedByHuman: false,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    statusReason: null,
    messageId: null,
    inReplyTo: null,
    sentAt: null,
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const AGENTS = [
  { id: "sdr-shadow", displayName: "Shadow Sam", trustTier: "shadow", role: "sales-sdr" },
  { id: "sdr-assisted", displayName: "Assisted Amy", trustTier: "assisted", role: "sales-sdr" },
];

function setup(initialItems: ReturnType<typeof makeOutboxItem>[]) {
  const state = { items: initialItems };

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (method === "GET" && path === "/v1/admin/outbox") {
      const statusParam = url.searchParams.get("status");
      const wanted = statusParam ? statusParam.split(",") : null;
      return ok({ items: state.items.filter((i) => !wanted || wanted.includes(i.status as string)) });
    }
    if (method === "GET" && path === "/v1/admin/agents") return ok({ agents: AGENTS });
    if (method === "GET" && path === "/v1/admin/contacts") return ok({ contacts: [] });

    const editMatch = /^\/v1\/admin\/outbox\/([^/]+)$/.exec(path);
    if (method === "PATCH" && editMatch) {
      const item = state.items.find((i) => i.id === editMatch[1])!;
      Object.assign(item, JSON.parse(String(init?.body)));
      return ok({ item });
    }
    const approveMatch = /^\/v1\/admin\/outbox\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && approveMatch) {
      const item = state.items.find((i) => i.id === approveMatch[1])!;
      item.status = "approved";
      return ok({ item });
    }
    const rejectMatch = /^\/v1\/admin\/outbox\/([^/]+)\/reject$/.exec(path);
    if (method === "POST" && rejectMatch) {
      const item = state.items.find((i) => i.id === rejectMatch[1])!;
      const body = JSON.parse(String(init?.body));
      item.status = "rejected";
      item.decisionNote = body.reason;
      return ok({ item });
    }
    throw new Error(`No mock route for ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const utils = render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <InboxPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { ...utils, state, fetchMock };
}

describe("Inbox approval flow", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a practice-draft banner for a shadow-tier agent's pending draft", async () => {
    setup([makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com" })]);
    await screen.findByRole("heading", { level: 2, name: /a@example.com/ });
    expect(screen.getByText(/Practice draft/i)).toBeTruthy();
  });

  it("hints that a pending draft was revised by the agent, and flags a superseded one", async () => {
    const { container } = setup([
      makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com", revisions: 2 }),
      makeOutboxItem({ id: "ob2", agentId: "sdr-shadow", to: "b@example.com", status: "rejected", decidedBy: "policy:superseded", statusReason: "superseded: replaced by a newer draft (ob3)" }),
    ]);
    await screen.findByRole("heading", { level: 2, name: /a@example.com/ });
    expect(container.textContent).toContain("revised ×2");
    expect(screen.getByText(/rewrote this draft 2 times/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Rejected" }));
    await screen.findByText("superseded");
  });

  it("offers Save & approve for an unsaved edit: one click saves the edit, then approves the saved version", async () => {
    const { fetchMock } = setup([makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com" })]);
    await waitFor(() => expect(screen.getByLabelText(/^body$/i)).toBeTruthy());

    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/^body$/i), { target: { value: "Edited body text." } });

    const btn = screen.getByRole("button", { name: "Save & approve" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    await waitFor(() => expect(screen.queryByText(/a@example.com/)).toBeNull());
    const calls = fetchMock.mock.calls
      .map(([u, init]) => `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(u), "http://localhost").pathname}`)
      .filter((c) => c.startsWith("PATCH") || c.endsWith("/approve"));
    expect(calls).toEqual(["PATCH /v1/admin/outbox/ob1", "POST /v1/admin/outbox/ob1/approve"]); // edit is recorded before the verdict
  });

  it("works the queue oldest-first and moves to the next draft after a decision", async () => {
    // The API lists newest first, so c (newest) comes first in the response and must be shown last.
    setup([
      makeOutboxItem({ id: "ob3", agentId: "sdr-shadow", to: "c@example.com" }),
      makeOutboxItem({ id: "ob2", agentId: "sdr-shadow", to: "b@example.com" }),
      makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com" }),
    ]);
    await screen.findByRole("heading", { level: 2, name: /a@example.com/ });
    fireEvent.keyDown(window, { key: "j" });
    await screen.findByRole("heading", { level: 2, name: /b@example.com/ });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    // b was decided from the middle: the next one (c) is shown, not a jump back to the top.
    await screen.findByRole("heading", { level: 2, name: /c@example.com/ });
  });

  it("approving a shadow-tier draft removes it from the pending list", async () => {
    setup([makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com" })]);
    await screen.findByRole("heading", { level: 2, name: /a@example.com/ });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.queryByText(/a@example.com/)).toBeNull());
  });

  it("rejecting needs a category; the written feedback is optional", async () => {
    setup([makeOutboxItem({ id: "ob1", agentId: "sdr-assisted", to: "a@example.com" })]);
    await screen.findByRole("heading", { level: 2, name: /a@example.com/ });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const confirmBtn = screen.getByRole("button", { name: /confirm reject/i }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/feedback for the agent/i), { target: { value: "Too aggressive a pitch." } });
    expect(confirmBtn.disabled).toBe(true); // feedback alone is not enough: the structured category is required
    fireEvent.click(screen.getByRole("button", { name: "Tone" }));
    expect(confirmBtn.disabled).toBe(false);

    fireEvent.click(confirmBtn);
    await waitFor(() => expect(screen.queryByText(/a@example.com/)).toBeNull());
  });

  it("rejects from the keyboard: R, a number key for the category, Ctrl+Enter", async () => {
    const { fetchMock } = setup([makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com" })]);
    await screen.findByRole("heading", { level: 2, name: /a@example.com/ });

    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "2" }); // Tone
    expect(screen.getByRole("button", { name: "Tone" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(screen.queryByText(/a@example.com/)).toBeNull());
    const rejectCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/reject"))!;
    expect(JSON.parse(String(rejectCall[1]?.body))).toEqual({ category: "tone" });
  });

  it("navigates between drafts with J/K", async () => {
    // API order is newest first; the queue is worked oldest-first, so a (listed last) is shown first.
    setup([
      makeOutboxItem({ id: "ob2", agentId: "sdr-assisted", to: "b@example.com" }),
      makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com" }),
    ]);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: /a@example.com/ })).toBeTruthy());

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: /b@example.com/ })).toBeTruthy());

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: /a@example.com/ })).toBeTruthy());
  });

  it("lists both drafts in the inbox list pane", async () => {
    setup([
      makeOutboxItem({ id: "ob1", agentId: "sdr-shadow", to: "a@example.com" }),
      makeOutboxItem({ id: "ob2", agentId: "sdr-assisted", to: "b@example.com" }),
    ]);
    const list = await screen.findByLabelText("Outbox items");
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThanOrEqual(2));
  });
});
