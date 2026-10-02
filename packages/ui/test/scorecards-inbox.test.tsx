// @vitest-environment jsdom
// Inbox additions for Phase 3 quality: lint findings, list badge, required rejection category.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InboxPage } from "../src/pages/Inbox/InboxPage.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { ok } from "./testUtils.ts";

function item(over: Record<string, unknown>) {
  return {
    id: "ob1", agentId: "sdr-01", taskId: null, channel: "email", to: "lead@example.com", subject: "Hello", body: "Draft body.", reason: "why",
    threadKey: null, status: "pending_approval", originalSubject: "Hello", originalBody: "Draft body.", editedByHuman: false, decidedBy: null,
    decidedAt: null, decisionNote: null, statusReason: null, messageId: null, inReplyTo: null, sentAt: null, attempts: 0, lint: [], rejectionCategory: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
}

function setup(items: ReturnType<typeof item>[]) {
  const rejectBodies: any[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname === "/v1/admin/outbox") return ok({ items });
    if (method === "GET" && url.pathname === "/v1/admin/agents") return ok({ agents: [{ id: "sdr-01", displayName: "Mai", trustTier: "assisted", role: "sales-sdr" }] });
    if (method === "GET" && url.pathname === "/v1/admin/contacts") return ok({ contacts: [] });
    if (method === "POST" && /\/reject$/.test(url.pathname)) {
      rejectBodies.push(JSON.parse(String(init?.body)));
      return ok({ item: items[0] });
    }
    throw new Error(`No mock route for ${method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <InboxPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { rejectBodies };
}

describe("Inbox lint + rejection category", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows lint findings above the body, errors first with severity styling, and a badge in the list row", async () => {
    setup([
      item({
        lint: [
          { code: "no_cta", severity: "warn", message: "No call to action." },
          { code: "unknown_price", severity: "error", message: "Price not in KB: $99." },
          { code: "missing_greeting_name", severity: "info", message: "Name not used." },
        ],
      }),
    ]);
    const list = await screen.findByLabelText("Lint findings");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-severity"))).toEqual(["error", "warn", "info"]);
    expect(rows[0]!.className).toContain("lint-error");
    expect(rows[0]!.textContent).toContain("Price not in KB: $99.");

    // above the body textarea in document order
    const body = screen.getByLabelText(/^body$/i);
    expect(list.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const listPane = screen.getByLabelText("Outbox items");
    expect(within(listPane).getByText("1 lint error")).toBeTruthy();
  });

  it("disables Approve while the draft has blocking (error) findings; warnings alone don't block", async () => {
    setup([item({ lint: [{ code: "placeholder", severity: "error", message: "Unfilled placeholder {{name}}." }] })]);
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Fix 1 blocking issue/)).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    setup([item({ lint: [{ code: "too_long", severity: "warn", message: "Long." }] })]);
    const approve2 = await screen.findByRole("button", { name: "Approve" });
    expect((approve2 as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders nothing for a clean draft, and tolerates items without a lint field", async () => {
    const legacy = item({});
    delete (legacy as Record<string, unknown>).lint;
    setup([legacy]);
    await screen.findByRole("heading", { level: 2, name: /lead@example.com/ });
    expect(screen.queryByLabelText("Lint findings")).toBeNull();
    expect(screen.queryByText(/lint (error|warning)/)).toBeNull();
  });

  it("reject requires a category (none preselected), then sends it with the reason", async () => {
    const { rejectBodies } = setup([item({})]);
    await screen.findByRole("heading", { level: 2, name: /lead@example.com/ });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    const chips = within(screen.getByRole("group", { name: "Rejection category" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual([
      "Factual error", "Tone", "Too long", "Not personalized", "Wrong recipient", "Bad timing", "Compliance", "Other",
    ]);
    expect(chips.every((c) => c.getAttribute("aria-pressed") === "false")).toBe(true);

    const confirm = screen.getByRole("button", { name: /confirm reject/i }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/feedback for the agent/i), { target: { value: "Quoted a price we do not publish." } });
    expect(confirm.disabled).toBe(true); // feedback alone is not enough

    fireEvent.click(screen.getByRole("button", { name: "Factual error" }));
    expect(screen.getByRole("button", { name: "Factual error" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Compliance" })); // single choice: switching replaces
    expect(screen.getByRole("button", { name: "Factual error" }).getAttribute("aria-pressed")).toBe("false");
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => expect(rejectBodies).toHaveLength(1));
    expect(rejectBodies[0]).toEqual({ reason: "Quoted a price we do not publish.", category: "compliance" });
  });

  it("a category alone is enough (one-click rejection) and sends no reason", async () => {
    const { rejectBodies } = setup([item({})]);
    await screen.findByRole("heading", { level: 2, name: /lead@example.com/ });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Tone" }));
    const confirm = screen.getByRole("button", { name: /confirm reject/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(rejectBodies).toEqual([{ category: "tone" }]));
  });
});
