// @vitest-environment jsdom
// Facebook in the UI: drafts in the Inbox (post preview, comment + reply, hide proposal), editing the planned time, the
// Facebook page (scheduled posts, cancel), and the Fanpage KPI card.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InboxPage } from "../src/pages/Inbox/InboxPage.tsx";
import { FacebookPage } from "../src/pages/Facebook/FacebookPage.tsx";
import { KpiGroups } from "../src/pages/Dashboard/KpiSection.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { fromLocalInput, toLocalInput } from "../src/pages/Inbox/FacebookPreview.tsx";
import { ok } from "./testUtils.ts";

const now = new Date().toISOString();

function item(overrides: Record<string, unknown>) {
  return {
    id: "ob-fb",
    agentId: "fp-01",
    taskId: null,
    channel: "facebook_reply",
    to: "fb:comment:c1",
    subject: "Reply to Lan",
    body: "Có bạn nhé, bên mình hỗ trợ TikTok Shop.",
    reason: "KB: supported channels",
    threadKey: "fb:comment:c1",
    status: "pending_approval",
    originalSubject: "Reply to Lan",
    originalBody: "Có bạn nhé, bên mình hỗ trợ TikTok Shop.",
    editedByHuman: false,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    statusReason: null,
    messageId: null,
    inReplyTo: null,
    sentAt: null,
    attempts: 0,
    lint: [],
    rejectionCategory: null,
    revisions: 0,
    payload: { kind: "reply", commentId: "c1", postId: "post-1", commentText: "Phần mềm có kết nối TikTok Shop không ad?", commenterName: "Lan Nguyễn" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const POST_PAYLOAD = { kind: "post", postType: "news", link: null, sourceUrl: "https://baomoi-eval.example/a.html", publishAt: "2026-10-07T01:30:00.000Z" };
const AGENTS = [{ id: "fp-01", displayName: "Fan", trustTier: "assisted", role: "fanpage-manager", status: "active" }];

function renderInbox(items: ReturnType<typeof item>[]) {
  const patches: unknown[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    if (method === "GET" && path === "/v1/admin/outbox") return ok({ items });
    if (method === "GET" && path === "/v1/admin/agents") return ok({ agents: AGENTS });
    if (method === "GET" && path === "/v1/admin/shadow") return ok({ active: null });
    if (method === "GET" && path === "/v1/admin/tasks") return ok({ tasks: [] });
    if (method === "GET" && path === "/v1/admin/facebook/status") {
      return ok({ status: { kind: "fake", configured: true, configError: null, pageId: "page-1", lastPollAt: null, lastPollError: null, lastSendAt: null, pollIntervalMs: 120000, scheduleLeadHours: 24 }, commentsByStatus: {} });
    }
    if (method === "GET" && path === "/v1/admin/contacts") throw new Error("a Facebook item must not look up a contact");
    if (method === "PATCH" && /^\/v1\/admin\/outbox\/[^/]+$/.test(path)) {
      const body = JSON.parse(String(init?.body));
      patches.push(body);
      return ok({ item: { ...items[0], ...(body.body ? { body: body.body } : {}), payload: body.publishAt !== undefined ? { ...(items[0]!.payload as object), publishAt: body.publishAt } : items[0]!.payload } });
    }
    throw new Error(`No mock route for ${method} ${path}`);
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
  return { fetchMock, patches };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Inbox: Facebook drafts", () => {
  it("shows the comment being answered above our reply, with no subject field and no contact lookup", async () => {
    renderInbox([item({})]);
    await screen.findByRole("heading", { level: 2, name: /Reply to Lan Nguyễn/ });
    expect(screen.getByLabelText("Comment on the Page").textContent).toContain("Phần mềm có kết nối TikTok Shop không ad?");
    expect(screen.getByLabelText("Comment on the Page").textContent).toContain("Lan Nguyễn");
    const reply = screen.getByLabelText("Our public reply") as HTMLTextAreaElement;
    expect(reply.value).toContain("TikTok Shop");
    expect(screen.queryByLabelText("Subject")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("shows a post preview with its type, source, and the never-posted-at-once note; the planned time is editable and saved as ISO", async () => {
    const { patches } = renderInbox([item({ id: "ob-post", channel: "facebook_post", to: "fb:page:page-1", subject: "Facebook post (news)", body: "Tin nóng. Nguồn: https://baomoi-eval.example/a.html", payload: POST_PAYLOAD })]);
    await screen.findByLabelText("Post preview");
    const preview = screen.getByLabelText("Post preview").textContent ?? "";
    expect(preview).toContain("news");
    expect(preview).toContain("https://baomoi-eval.example/a.html");
    await waitFor(() => expect(screen.getByLabelText("Post preview").textContent).toMatch(/at least 24h from approval/));
    expect(screen.getByLabelText("Post preview").textContent).toMatch(/Never posted at once/);

    const when = screen.getByLabelText(/Planned go-live/) as HTMLInputElement;
    expect(when.value).toBe(toLocalInput("2026-10-07T01:30:00.000Z"));
    fireEvent.change(when, { target: { value: "2026-10-12T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ body: "Tin nóng. Nguồn: https://baomoi-eval.example/a.html", publishAt: fromLocalInput("2026-10-12T09:00") });
  });

  it("shows a hide proposal as such, with the reason and the comment, and nothing to type", async () => {
    renderInbox([item({ id: "ob-hide", channel: "facebook_hide", to: "fb:hide:c2", subject: "Hide comment", body: "quảng cáo kiếm tiền online", payload: { kind: "hide", commentId: "c2", postId: "post-1", commentText: "KIẾM 20TR/NGÀY", commenterName: "Việc Làm 24h", reason: "quảng cáo kiếm tiền online" } })]);
    await screen.findByRole("heading", { level: 2, name: /Hide comment by Việc Làm 24h/ });
    expect(screen.getByText(/Proposed: hide this comment/)).toBeTruthy();
    expect(screen.getByLabelText("Comment on the Page").textContent).toContain("KIẾM 20TR/NGÀY");
    expect(screen.queryByLabelText("Our public reply")).toBeNull();
  });

  it("the list row says what the Facebook item is instead of an address", async () => {
    renderInbox([item({})]);
    const row = await screen.findByRole("button", { name: /Reply to Lan Nguyễn/ });
    expect(row.textContent).toContain("Facebook ·");
    expect(row.textContent).not.toContain("fb:comment");
  });
});

describe("datetime helpers", () => {
  it("round-trip an ISO instant through the browser's local input format", () => {
    const iso = "2026-10-07T01:30:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
  });
});

describe("Facebook page", () => {
  function renderPage(scheduled: unknown, status: Record<string, unknown> = {}) {
    const cancelled: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.pathname === "/v1/admin/facebook/status") {
          return ok({ status: { kind: "graph", configured: true, configError: null, pageId: "123", lastPollAt: now, lastPollError: null, lastSendAt: null, pollIntervalMs: 120000, scheduleLeadHours: 24, ...status }, commentsByStatus: { new: 2, assigned: 1, replied: 5, hidden: 1 } });
        }
        if (url.pathname === "/v1/admin/facebook/scheduled" && method === "GET") return ok(scheduled);
        const cancel = /^\/v1\/admin\/facebook\/scheduled\/([^/]+)\/cancel$/.exec(url.pathname);
        if (cancel && method === "POST") {
          cancelled.push(decodeURIComponent(cancel[1]!));
          return ok({ postId: cancelled[0] });
        }
        throw new Error(`No mock route for ${method} ${url.pathname}`);
      }),
    );
    render(
      <MemoryRouter>
        <AuthProvider>
          <ToastProvider>
            <FacebookPage />
          </ToastProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    return { cancelled };
  }

  it("lists scheduled posts and cancels one after a confirm", async () => {
    const { cancelled } = renderPage({ posts: [{ postId: "123_9", message: "Bài sắp đăng về bản 2.4", scheduledPublishTime: "2026-10-07T01:30:00.000Z", permalinkUrl: null, outboxId: "obx_1" }], source: "facebook", error: null });
    await screen.findByText("Bài sắp đăng về bản 2.4");
    expect(screen.getByText(/2 waiting · 1 with an agent · 5 replied · 1 hidden/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the post" }));
    await waitFor(() => expect(cancelled).toEqual(["123_9"]));
  });

  it("says so when Facebook could not be asked and shows what we sent; and when it is not connected", async () => {
    renderPage({ posts: [], source: "local", error: "graph down" }, { configured: false, configError: "environment variable AGYHQ_FB_PAGE_TOKEN is not set" });
    await screen.findByText(/Showing what we sent/);
    expect(screen.getByText(/graph down/)).toBeTruthy();
    expect(screen.getByText(/AGYHQ_FB_PAGE_TOKEN is not set/)).toBeTruthy();
    expect(screen.getByText("No scheduled posts.")).toBeTruthy();
  });
});

describe("Fanpage KPI card", () => {
  const base = {
    windowDays: 7,
    roles: {
      "sales-sdr": { agents: 0 },
      "account-manager": { agents: 0 },
      "chief-of-staff": { agents: 0 },
      "fanpage-manager": { agents: 1, postsDrafted: 3, postsScheduled: 2, commentsReceived: 14, repliesDrafted: 9, repliesSent: 7, hideProposals: 2, escalations: 1, handoffs: 1 },
    },
    common: { tasksDone: 0, tasksFailed: 0, needsHuman: 0, approvalRate: null, medianEditRatio: null },
  };

  it("shows real counts for the Fanpage Manager", () => {
    render(<KpiGroups report={base as never} />);
    const group = screen.getByLabelText("Fanpage Manager");
    expect(group.textContent).toContain("Comments received");
    expect(group.textContent).toContain("14");
    expect(group.textContent).toContain("Hide proposals");
  });

  it("is absent when there is no fanpage agent, and tolerates an older daemon with no fanpage block", () => {
    const none = { ...base, roles: { ...base.roles, "fanpage-manager": { ...base.roles["fanpage-manager"], agents: 0 } } };
    render(<KpiGroups report={none as never} />);
    expect(screen.queryByLabelText("Fanpage Manager")).toBeNull();
    cleanup();
    const { "fanpage-manager": _omit, ...older } = base.roles;
    render(<KpiGroups report={{ ...base, roles: older } as never} />);
    expect(screen.queryByLabelText("Fanpage Manager")).toBeNull();
  });
});
