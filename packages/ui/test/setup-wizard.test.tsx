// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReadinessReport } from "@agyhq/core";
import { SetupPage } from "../src/pages/Setup/SetupPage.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { eventHub } from "../src/api/sse.ts";
import { MockEventSource, fail, installMockEventSource, ok, routeFetch } from "./testUtils.ts";

type Status = "pass" | "warn" | "fail";
const CHECK_IDS = [
  "company.profile",
  "kb.company_present",
  "kb.no_placeholders",
  "email.provider",
  "email.verified",
  "sender.identity",
  "unsubscribe.mailto",
  "agents.sdr_present",
  "settings.default_sdr",
];

function report(overrides: Record<string, Status> = {}, all: Status = "fail"): ReadinessReport {
  const checks = CHECK_IDS.map((id) => ({
    id,
    title: `Check ${id}`,
    status: overrides[id] ?? all,
    detail: `Detail for ${id}`,
    fixPath: "/setup",
  }));
  return { ready: checks.every((c) => c.status !== "fail"), at: new Date().toISOString(), checks };
}

const STATUS = {
  version: "1.0.0",
  startedAt: new Date().toISOString(),
  agyVersion: "1.2.14",
  email: { provider: "imap-smtp", address: "mai@acme.vn", ok: true, error: null, lastPollAt: null, lastSendAt: null },
  outboundEnabled: false,
  outboundDisabledReason: "not yet enabled",
  inQuietHours: false,
  quotaThrottled: false,
  runningTasks: 0,
};

const PROFILE = {
  companyName: "Acme Vietnam",
  website: "https://acme.vn",
  oneLiner: "Phần mềm đồng bộ tồn kho cho người bán đa kênh.",
  productDescription: "Acme đồng bộ tồn kho theo thời gian thực giữa các sàn.",
  targetCustomers: "Cửa hàng thương mại điện tử 5-50 nhân viên.",
  painPoints: "- Bán lố hàng\n- Đối soát thủ công",
  differentiators: "",
  pricingPolicy: "Không báo giá, mời gọi một cuộc gọi.",
  proofPoints: "",
  forbiddenClaims: "",
  meetingLink: null,
  languages: ["vi"],
};

function doneJob(extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    domain: "acme.vn",
    model: "gemini-3.8-flash-medium",
    status: "done",
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    finishedAt: new Date().toISOString(),
    progress: [{ at: new Date().toISOString(), line: "Đọc trang chủ" }],
    error: null,
    usage: null,
    result: {
      profile: PROFILE,
      roleKb: {
        role: "sales-sdr",
        files: [
          { relPath: "icp.md", title: "ICP", body: "# ICP\n\nCửa hàng đa kênh." },
          { relPath: "sales-playbook.md", title: "Playbook", body: "# Playbook\n\nMở đầu ngắn gọn." },
        ],
      },
      suggestedSender: {
        name: "Mai — Acme",
        address: "sales@acme.vn",
        companyAddressLine: "Acme Ltd, 12 Nguyễn Huệ, Q.1, TP.HCM",
        unsubscribeMailto: "huy@acme.vn",
      },
      sources: [{ url: "https://acme.vn/", title: "Trang chủ Acme" }],
      conflicts: ["Hai bảng giá khác nhau: /pricing và /plans"],
      openQuestions: ["Chính sách hoàn tiền là gì?"],
    },
    ...extra,
  };
}
const runningJob = (lines: string[] = []) => ({
  ...doneJob(),
  status: "running",
  finishedAt: null,
  result: null,
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  progress: lines.map((line) => ({ at: new Date().toISOString(), line })),
});

const EMAIL_NONE = { kind: "none", address: null, displayName: null, imap: null, smtp: null, mailbox: null, sentFolder: null, pollIntervalMs: null, root: null, source: "config", passwordFromEnv: { imap: false, smtp: false } };
const EMAIL_SAVED = {
  kind: "imap-smtp",
  address: "mai@acme.vn",
  displayName: "Mai",
  imap: { host: "imap.gmail.com", port: 993, secure: true, user: "mai@acme.vn", hasPassword: true },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "mai@acme.vn", hasPassword: true },
  mailbox: "INBOX",
  sentFolder: null,
  pollIntervalMs: 60000,
  root: null,
  source: "ui",
  passwordFromEnv: { imap: false, smtp: false },
};

interface World {
  readiness: ReadinessReport;
  profile: any;
  jobs: any[];
  jobById: Record<string, any>;
  roleKb: { source: "override" | "template"; files: any[] };
  fanpageKb: { source: "override" | "template"; files: any[] };
  email: any;
  sender: any;
  agents: any[];
  settings: { defaultSdrAgentId: string | null };
  statusOverride: Record<string, unknown>;
  calls: Record<string, any[]>;
  routes: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>;
  readinessCalls: number;
}

function mount(initial: string, patch: Partial<World> = {}) {
  installMockEventSource();
  localStorage.setItem("agyhq_admin_token", "t");
  const w: World = {
    readiness: report(),
    profile: null,
    jobs: [],
    jobById: {},
    roleKb: { source: "template", files: [] },
    fanpageKb: { source: "template", files: [] },
    email: EMAIL_NONE,
    sender: { name: "", address: "", companyAddressLine: "", unsubscribeMailto: "", source: "config" },
    agents: [],
    settings: { defaultSdrAgentId: null },
    statusOverride: {},
    calls: {},
    routes: {},
    readinessCalls: 0,
    ...patch,
  };
  const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? "null"));
  const rec = (k: string, v: unknown) => (w.calls[k] ??= []).push(v);
  const routes: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>> = {
    "GET /v1/admin/status": () => ok({ status: { ...STATUS, ...w.statusOverride } }),
    "GET /v1/admin/readiness": () => {
      w.readinessCalls++;
      return ok({ readiness: w.readiness });
    },
    "GET /v1/admin/setup/company": () => ok({ profile: w.profile }),
    "PUT /v1/admin/setup/company": (_u, init) => {
      rec("putCompany", body(init));
      w.profile = { ...PROFILE, ...body(init), updatedAt: new Date().toISOString() };
      return ok({ profile: w.profile, files: ["company/product.md"] });
    },
    "GET /v1/admin/setup/generate": () => ok({ jobs: w.jobs }),
    "POST /v1/admin/setup/generate": (_u, init) => {
      rec("generate", body(init));
      const job = runningJob();
      w.jobs = [job];
      w.jobById[job.id] = job;
      return ok({ job }, 202);
    },
    "GET /v1/admin/setup/generate/job-1": () => ok({ job: w.jobById["job-1"] ?? w.jobs[0] }),
    "POST /v1/admin/setup/generate/job-1/cancel": () => {
      rec("cancel", true);
      return ok({ job: { ...runningJob(), status: "cancelled", finishedAt: new Date().toISOString() } });
    },
    "GET /v1/admin/setup/role-kb": (u) => {
      const role = u.searchParams.get("role") ?? "sales-sdr";
      return ok({ role, ...(role === "fanpage-manager" ? w.fanpageKb : w.roleKb) });
    },
    "PUT /v1/admin/setup/role-kb": (_u, init) => {
      const b = body(init);
      rec("putKb", b);
      const next = { source: "override" as const, files: b.files.map((f: any) => ({ ...f, title: f.relPath, hasPlaceholders: false })) };
      if (b.role === "fanpage-manager") w.fanpageKb = next;
      else w.roleKb = next;
      return ok({ role: b.role, ...next });
    },
    "GET /v1/admin/setup/email": () => ok({ email: w.email }),
    "PUT /v1/admin/setup/email": (_u, init) => {
      const b = body(init);
      rec("putEmail", b);
      w.email = {
        ...EMAIL_SAVED,
        address: b.address,
        displayName: b.displayName ?? null,
        imap: { host: b.imap.host, port: b.imap.port, secure: b.imap.secure, user: b.imap.user, hasPassword: true },
        smtp: { host: b.smtp.host, port: b.smtp.port, secure: b.smtp.secure, user: b.smtp.user, hasPassword: true },
      };
      return ok({ email: w.email });
    },
    "POST /v1/admin/setup/email/test": (_u, init) => {
      rec("testEmail", body(init));
      return ok({ imap: { ok: true, error: null }, smtp: { ok: false, error: "535 Authentication failed" } });
    },
    "GET /v1/admin/setup/sender": () => ok({ sender: w.sender }),
    "PUT /v1/admin/setup/sender": (_u, init) => {
      rec("putSender", body(init));
      w.sender = { ...body(init), source: "ui" };
      return ok({ sender: w.sender });
    },
    "GET /v1/admin/agents": () => ok({ agents: w.agents }),
    "POST /v1/admin/agents": (_u, init) => {
      const b = body(init);
      rec("createAgent", b);
      const agent = { ...b, status: "active", workspacePath: "/w", managerId: null, policy: {}, maxConcurrency: 1 };
      w.agents = [agent];
      return ok({ agent }, 201);
    },
    "GET /v1/admin/settings": () => ok({ settings: w.settings }),
    "PATCH /v1/admin/settings": (_u, init) => {
      rec("patchSettings", body(init));
      w.settings = { ...w.settings, ...body(init) };
      return ok({ settings: w.settings });
    },
    "POST /v1/admin/killswitch": (_u, init) => {
      rec("killswitch", body(init));
      return ok({ settings: {} });
    },
    ...w.routes,
  };
  vi.stubGlobal("fetch", routeFetch(routes));
  const utils = render(
    <MemoryRouter initialEntries={[initial]}>
      <AuthProvider>
        <ToastProvider>
          <SetupPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { ...utils, w };
}

function emit(type: string, data: Record<string, unknown>) {
  const es = MockEventSource.instances[MockEventSource.instances.length - 1]!;
  act(() => {
    for (const cb of es.listeners.get(type) ?? []) cb({ data: JSON.stringify({ type, data, at: new Date().toISOString() }) } as MessageEvent);
  });
}

const step = (name: RegExp) => screen.getByRole("button", { name });
const change = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Setup wizard", () => {
  afterEach(() => {
    cleanup();
    eventHub.stop();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("stepper shows status dots derived from readiness and the step from the URL", async () => {
    mount(
      "/setup?step=email",
      {
        readiness: report({
          "company.profile": "pass",
          "kb.company_present": "pass",
          "email.provider": "pass",
          "email.verified": "fail",
          "agents.sdr_present": "pass",
          "agents.settings_default": "pass",
          "settings.default_sdr": "pass",
        }),
      },
    );
    await waitFor(() => expect(step(/^Công ty/).getAttribute("data-status")).toBe("done"));
    expect(step(/^Kiến thức bán hàng/).getAttribute("data-status")).toBe("attention"); // company done, placeholders remain
    expect(step(/^Email/).getAttribute("data-status")).toBe("attention"); // provider ok, not verified
    expect(step(/^Người gửi/).getAttribute("data-status")).toBe("todo");
    expect(step(/^Agent SDR/).getAttribute("data-status")).toBe("done");
    expect(step(/^Go-live/).getAttribute("data-status")).toBe("todo");
    expect(within(step(/^Công ty/)).getByText("xong")).toBeTruthy();
    expect(within(step(/^Người gửi/)).getByText("chưa làm")).toBeTruthy();
    expect(step(/^Email/).getAttribute("aria-current")).toBe("step");
    expect(screen.getByRole("heading", { name: /3\. Email/ })).toBeTruthy();
  });

  it("maps legacy /setup#email links to the email step", async () => {
    mount("/setup#email");
    expect(await screen.findByRole("heading", { name: /3\. Email/ })).toBeTruthy();
  });

  it("generate -> live progress -> review with conflicts gating save -> PUT company", async () => {
    const { w } = mount("/setup?step=company");
    await screen.findByRole("heading", { name: "Tạo bằng AI từ website" });
    // No saved profile: the form stays hidden until the user applies a result or chooses manual entry.
    expect(screen.queryByLabelText(/^Tên công ty/)).toBeNull();

    change("Tên miền công ty", "https://Acme.vn/");
    fireEvent.click(screen.getByRole("button", { name: "Tạo bằng AI" }));
    await waitFor(() => expect(w.calls.generate).toHaveLength(1));
    expect(w.calls.generate![0]).toMatchObject({ domain: "acme.vn", language: "vi", extraUrls: [], includeFanpage: true });

    const log = await screen.findByRole("log", { name: /tiến trình/i });
    expect(log.getAttribute("aria-live")).toBe("polite");
    emit("setup.job.progress", { jobId: "job-1", line: "Đang đọc https://acme.vn/pricing" });
    expect(await within(log).findByText(/Đang đọc https:\/\/acme.vn\/pricing/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Huỷ" })).toBeTruthy();

    // Job finishes.
    w.jobById["job-1"] = doneJob();
    w.jobs = [w.jobById["job-1"]];
    emit("setup.job.updated", { jobId: "job-1", status: "done" });

    const conflicts = await screen.findByRole("group", { name: "Mâu thuẫn" });
    expect(within(conflicts).getByText(/Hai bảng giá khác nhau/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "Cần bạn bổ sung" })).toBeTruthy();
    expect(screen.getByText(/Chính sách hoàn tiền là gì/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Trang chủ Acme" });
    expect(link.getAttribute("href")).toBe("https://acme.vn/");
    // Result does not touch the form until applied.
    expect(screen.queryByLabelText(/^Tên công ty/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dùng kết quả này" }));
    await waitFor(() => expect((screen.getByLabelText(/^Tên công ty/) as HTMLInputElement).value).toBe("Acme Vietnam"));
    expect(screen.getByText(/Chưa có gì được lưu cho đến khi bạn bấm “Lưu hồ sơ”/)).toBeTruthy();

    // Conflicts must be acknowledged first.
    const save = screen.getByRole("button", { name: "Lưu hồ sơ" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/tick “Tôi đã xem các mâu thuẫn”/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Tôi đã xem các mâu thuẫn"));
    expect(save.disabled).toBe(false);

    const before = w.readinessCalls;
    fireEvent.click(save);
    await waitFor(() => expect(w.calls.putCompany).toHaveLength(1));
    expect(w.calls.putCompany![0]).toMatchObject({ companyName: "Acme Vietnam", website: "https://acme.vn", languages: ["vi"] });
    await waitFor(() => expect(w.readinessCalls).toBeGreaterThan(before));
  });

  it("restores a running job on load (progress + cancel) and shows the saved profile without replacing it", async () => {
    const { w } = mount("/setup?step=company", { jobs: [runningJob(["Bắt đầu", "Đọc trang chủ"])], profile: { ...PROFILE, updatedAt: new Date().toISOString() } });
    const log = await screen.findByRole("log", { name: /tiến trình/i });
    expect(within(log).getByText("Đọc trang chủ")).toBeTruthy();
    // Saved profile is shown in the form.
    await waitFor(() => expect((screen.getByLabelText(/^Tên công ty/) as HTMLInputElement).value).toBe("Acme Vietnam"));
    fireEvent.click(screen.getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(w.calls.cancel).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: /Đã huỷ lần tạo/ })).toBeTruthy();
  });

  it("manual entry skips AI and shows the form", async () => {
    mount("/setup?step=company");
    fireEvent.click(await screen.findByRole("button", { name: "Tự điền thủ công" }));
    expect(await screen.findByLabelText(/^Tên công ty/)).toBeTruthy();
  });

  it("role KB: loads template files, edits and saves all; AI version replaces after confirm", async () => {
    const { w } = mount("/setup?step=kb", {
      roleKb: {
        source: "template",
        files: [
          { relPath: "icp.md", title: "ICP", body: "# ICP\n\nTODO: điền khách hàng", hasPlaceholders: true },
          { relPath: "objections.md", title: "Phản đối", body: "# Phản đối\n\nĐã viết xong.", hasPlaceholders: false },
        ],
      },
      jobs: [doneJob()],
    });
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["icp.md ⚠", "objections.md"]);
    expect(screen.getByText("Mẫu")).toBeTruthy();
    expect(screen.getByText("⚠ Còn placeholder")).toBeTruthy();

    // Edit with live preview.
    const editor = screen.getByLabelText(/^Nội dung icp\.md/) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# ICP\n\nCửa hàng đa kênh ở Việt Nam" } });
    expect(screen.getByText("Cửa hàng đa kênh ở Việt Nam", { selector: ".wz-preview *" })).toBeTruthy();
    expect(screen.queryByText("⚠ Còn placeholder")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lưu tất cả" }));
    await waitFor(() => expect(w.calls.putKb).toHaveLength(1));
    expect(w.calls.putKb![0]).toEqual({
      role: "sales-sdr",
      files: [
        { relPath: "icp.md", body: "# ICP\n\nCửa hàng đa kênh ở Việt Nam" },
        { relPath: "objections.md", body: "# Phản đối\n\nĐã viết xong." },
      ],
    });
    expect((await screen.findAllByText("Đã tùy chỉnh")).length).toBeGreaterThan(0);

    // "Dùng bản AI tạo" asks for confirmation, then replaces the files (unsaved).
    fireEvent.click(screen.getByRole("button", { name: "Dùng bản AI tạo" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Thay bằng bản AI" }));
    await waitFor(() => expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["icp.md", "sales-playbook.md"]));
    expect(screen.getByText("AI tạo")).toBeTruthy();
    expect(w.calls.putKb).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Lưu tất cả" }));
    await waitFor(() => expect(w.calls.putKb).toHaveLength(2));
    expect(w.calls.putKb![1].files.map((f: any) => f.relPath)).toEqual(["icp.md", "sales-playbook.md"]);
  });

  it("role KB: Fanpage Manager tab loads its own KB, offers the AI draft with open questions, and saves with its own role", async () => {
    const job: any = doneJob();
    job.result.fanpageKb = {
      role: "fanpage-manager",
      files: [
        { relPath: "page-voice.md", title: "Giọng Page", body: "# Giọng Page\n\nThân thiện, xưng “bên mình”." },
        { relPath: "content-pillars.md", title: "Nhóm nội dung", body: "# Nhóm nội dung\n\nTính năng mới, mẹo dùng." },
        { relPath: "comment-policy.md", title: "Chính sách bình luận", body: "# Chính sách bình luận\n\nKhiếu nại chuyển cho người." },
      ],
    };
    job.result.openQuestions = ["Chính sách hoàn tiền là gì?", "Fanpage: page-voice.md — số bài mỗi tuần là đề xuất, chủ Page cần xác nhận"];
    const { w } = mount("/setup?step=kb", {
      roleKb: { source: "override", files: [{ relPath: "icp.md", title: "ICP", body: "# ICP\n\nOK", hasPlaceholders: false }] },
      fanpageKb: { source: "template", files: [{ relPath: "page-voice.md", title: "Voice", body: "# Voice\n\nTODO", hasPlaceholders: true }] },
      jobs: [job],
    });
    await screen.findByRole("tab", { name: "icp.md" });
    fireEvent.click(screen.getByRole("button", { name: "Fanpage Manager" }));
    expect((await screen.findAllByRole("tab")).map((t) => t.textContent)).toEqual(["page-voice.md ⚠"]);

    // Only the open questions the AI flagged for the Page are shown here, without the "Fanpage:" prefix.
    expect(screen.getByText(/số bài mỗi tuần là đề xuất/)).toBeTruthy();
    expect(screen.queryByText(/hoàn tiền/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dùng bản AI tạo" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Thay bằng bản AI" }));
    await waitFor(() => expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["page-voice.md", "content-pillars.md", "comment-policy.md"]));
    fireEvent.click(screen.getByRole("button", { name: "Lưu tất cả" }));
    await waitFor(() => expect(w.calls.putKb).toHaveLength(1));
    expect(w.calls.putKb![0].role).toBe("fanpage-manager");
    expect(w.calls.putKb![0].files.map((f: any) => f.relPath)).toEqual(["page-voice.md", "content-pillars.md", "comment-policy.md"]);
  });

  it("email: Gmail preset fills servers, test shows IMAP and SMTP separately, save sends the shared password", async () => {
    const { w } = mount("/setup?step=email");
    fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
    expect((screen.getByLabelText("Máy chủ IMAP") as HTMLInputElement).value).toBe("imap.gmail.com");
    expect((screen.getByLabelText("Cổng SMTP") as HTMLInputElement).value).toBe("465");
    expect(screen.getByText(/App Password/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Outlook / Microsoft 365" }));
    expect((screen.getByLabelText("Máy chủ SMTP") as HTMLInputElement).value).toBe("smtp.office365.com");
    expect((screen.getByLabelText("Cổng SMTP") as HTMLInputElement).value).toBe("587");
    expect((screen.getByLabelText("Dùng SSL/TLS (SMTP)") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));

    // Inline validation first.
    change("Địa chỉ email", "khong-hop-le");
    fireEvent.click(screen.getByRole("button", { name: "Kiểm tra kết nối" }));
    expect(await screen.findByText(/Nhập địa chỉ email hợp lệ/)).toBeTruthy();
    expect(w.calls.testEmail).toBeUndefined();

    change("Địa chỉ email", "mai@acme.vn");
    expect((screen.getByLabelText("Tên đăng nhập IMAP") as HTMLInputElement).value).toBe("mai@acme.vn");
    change(/^Mật khẩu \(dùng chung/, "app-pass-123");
    fireEvent.click(screen.getByRole("button", { name: "Kiểm tra kết nối" }));
    await waitFor(() => expect(w.calls.testEmail).toHaveLength(1));
    expect(w.calls.testEmail![0]).toMatchObject({
      kind: "imap-smtp",
      address: "mai@acme.vn",
      imap: { host: "imap.gmail.com", port: 993, secure: true, user: "mai@acme.vn", pass: "app-pass-123" },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "mai@acme.vn", pass: "app-pass-123" },
      sentFolder: null,
    });
    expect(await screen.findByText(/IMAP: kết nối được/)).toBeTruthy();
    expect(screen.getByText(/SMTP: không kết nối được — 535 Authentication failed/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(w.calls.putEmail).toHaveLength(1));
    expect(w.calls.putEmail![0].smtp.pass).toBe("app-pass-123");
    // After saving, the password is never shown again; the field says it is stored.
    expect(await screen.findByText(/✓ Đã lưu — để trống nếu không đổi/)).toBeTruthy();
    expect((screen.getByLabelText(/^Mật khẩu \(dùng chung/) as HTMLInputElement).value).toBe("");
  });

  it("email: with a stored password, saving without typing one omits `pass` and keeps 'Đã lưu'; env notice shown", async () => {
    const { w } = mount("/setup?step=email", { email: { ...EMAIL_SAVED, passwordFromEnv: { imap: true, smtp: false } } });
    expect(await screen.findByText(/✓ Đã lưu — để trống nếu không đổi/)).toBeTruthy();
    expect(screen.getByText(/AGYHQ_IMAP_PASS/)).toBeTruthy();
    expect((screen.getByLabelText("Máy chủ IMAP") as HTMLInputElement).value).toBe("imap.gmail.com");
    expect(screen.getByRole("button", { name: "Gmail" }).getAttribute("aria-pressed")).toBe("true");

    change("Tên hiển thị", "Mai Nguyễn");
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(w.calls.putEmail).toHaveLength(1));
    expect(w.calls.putEmail![0].displayName).toBe("Mai Nguyễn");
    expect(w.calls.putEmail![0].imap).not.toHaveProperty("pass");
    expect(w.calls.putEmail![0].smtp).not.toHaveProperty("pass");
    expect(await screen.findByText(/✓ Đã lưu — để trống nếu không đổi/)).toBeTruthy();
  });

  it("sender: prefills from the AI suggestion, live footer preview matches the sent footer, save -> PUT", async () => {
    const { w } = mount("/setup?step=sender", { jobs: [doneJob()], email: EMAIL_SAVED });
    await waitFor(() => expect((screen.getByLabelText(/^Tên người gửi/) as HTMLInputElement).value).toBe("Mai — Acme"));
    // Address defaults to the email step's address, not the suggestion.
    expect((screen.getByLabelText(/^Địa chỉ gửi/) as HTMLInputElement).value).toBe("mai@acme.vn");
    expect(screen.getAllByText("Gợi ý từ website").length).toBe(3);

    const preview = screen.getByTestId("footer-preview");
    expect(preview.textContent).toBe(
      '\n--\nMai — Acme\nAcme Ltd, 12 Nguyễn Huệ, Q.1, TP.HCM\nDon\'t want these emails? Reply "unsubscribe" or email huy@acme.vn.',
    );
    change(/^Tên người gửi/, "Mai Nguyễn");
    expect(screen.getByTestId("footer-preview").textContent).toContain("\nMai Nguyễn\n");

    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(w.calls.putSender).toHaveLength(1));
    expect(w.calls.putSender![0]).toEqual({
      name: "Mai Nguyễn",
      address: "mai@acme.vn",
      companyAddressLine: "Acme Ltd, 12 Nguyễn Huệ, Q.1, TP.HCM",
      unsubscribeMailto: "huy@acme.vn",
    });
    await waitFor(() => expect(screen.queryByText("Gợi ý từ website")).toBeNull());
  });

  it("sender: saved values win over the suggestion; invalid input blocks save", async () => {
    const { w } = mount("/setup?step=sender", {
      jobs: [doneJob()],
      sender: { name: "Đã lưu", address: "a@acme.vn", companyAddressLine: "Địa chỉ đã lưu 123", unsubscribeMailto: "u@acme.vn", source: "ui" },
    });
    await waitFor(() => expect((screen.getByLabelText(/^Tên người gửi/) as HTMLInputElement).value).toBe("Đã lưu"));
    expect(screen.queryByText("Gợi ý từ website")).toBeNull();
    change(/^Email nhận yêu cầu huỷ/, "sai");
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    expect(await screen.findByText(/Nhập địa chỉ email hợp lệ/)).toBeTruthy();
    expect(w.calls.putSender).toBeUndefined();
  });

  it("agent: creates an SDR in shadow mode with defaults and makes it the default SDR", async () => {
    const { w } = mount("/setup?step=agent");
    const form = await screen.findByRole("heading", { name: "Tạo agent SDR" });
    expect(form).toBeTruthy();
    expect(screen.getByText(/chế độ thực hành/i)).toBeTruthy();
    expect((screen.getByLabelText("Mã agent") as HTMLInputElement).value).toBe("sdr-01");
    expect((screen.getByLabelText("Model AI") as HTMLInputElement).value).toBe("gemini-3.8-flash-medium");
    change("Mã agent", "Sai Mã!");
    fireEvent.click(screen.getByRole("button", { name: "Tạo agent" }));
    expect(await screen.findByText(/Mã agent gồm chữ thường/)).toBeTruthy();
    expect(w.calls.createAgent).toBeUndefined();

    change("Mã agent", "sdr-01");
    change("Tên hiển thị", "Mai SDR");
    fireEvent.click(screen.getByRole("button", { name: "Tạo agent" }));
    await waitFor(() => expect(w.calls.createAgent).toHaveLength(1));
    expect(w.calls.createAgent![0]).toEqual({ id: "sdr-01", role: "sales-sdr", displayName: "Mai SDR", model: "gemini-3.8-flash-medium", trustTier: "shadow" });
    await waitFor(() => expect(w.calls.patchSettings).toEqual([{ defaultSdrAgentId: "sdr-01" }]));
    const radio = await screen.findByRole("radio", { name: /Mai SDR/ });
    await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));
  });

  it("agent: choosing another SDR patches the default", async () => {
    const mk = (id: string) => ({ id, role: "sales-sdr", displayName: `Agent ${id}`, model: "m", status: "active", trustTier: "shadow" });
    const { w } = mount("/setup?step=agent", { agents: [mk("sdr-01"), mk("sdr-02")], settings: { defaultSdrAgentId: "sdr-01" } });
    const second = await screen.findByRole("radio", { name: /Agent sdr-02/ });
    await waitFor(() => expect((screen.getByRole("radio", { name: /Agent sdr-01/ }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(second);
    await waitFor(() => expect(w.calls.patchSettings).toEqual([{ defaultSdrAgentId: "sdr-02" }]));
    expect(screen.queryByRole("heading", { name: "Tạo agent SDR" })).toBeNull();
  });

  it("go-live: 409 lists failing checks with in-wizard fix links and offers no force", async () => {
    const kills: any[] = [];
    mount("/setup?step=golive", {
      readiness: report({ "company.profile": "pass", "kb.company_present": "pass" }),
      routes: {
        "POST /v1/admin/killswitch": (_u, init) => {
          kills.push(JSON.parse(String(init?.body)));
          return fail("conflict", "Cannot enable outbound: 7 readiness checks failing", 409);
        },
      },
    });
    // Checklist fix links jump to the wizard step.
    const items = await screen.findAllByRole("link", { name: /^Xử lý: Check email\.provider/ });
    expect(items[0]!.getAttribute("href")).toBe("/setup?step=email");

    fireEvent.click(screen.getByRole("button", { name: "Bật gửi email" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Bật" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Cannot enable outbound/)).toBeTruthy();
    expect(within(alert).getByText(/Check email\.provider/)).toBeTruthy();
    expect(within(alert).getByRole("link", { name: /Xử lý: Check agents\.sdr_present/ }).getAttribute("href")).toBe("/setup?step=agent");
    expect(screen.queryByRole("button", { name: /ép bật|force/i })).toBeNull();
    expect(screen.getByText(/ép bật từ trang Dashboard/)).toBeTruthy();
    expect(kills).toHaveLength(1);
    expect(kills[0]).not.toHaveProperty("force");
  });

  it("go-live: enabling succeeds when ready; already-enabled shows Inbox link", async () => {
    const ready = report({}, "pass");
    const { w } = mount("/setup?step=golive", { readiness: ready });
    fireEvent.click(await screen.findByRole("button", { name: "Bật gửi email" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Bật" }));
    await waitFor(() => expect(w.calls.killswitch).toHaveLength(1));
    expect(w.calls.killswitch![0]).toMatchObject({ outboundEnabled: true });
    cleanup();

    mount("/setup?step=golive", { readiness: ready, statusOverride: { outboundEnabled: true } });
    expect((await screen.findByRole("link", { name: "Mở Inbox" })).getAttribute("href")).toBe("/inbox");
    expect(screen.queryByRole("button", { name: "Bật gửi email" })).toBeNull();
  });

  it("navigation: dirty step asks before discarding; Tiếp tục saves and moves on", async () => {
    const { w } = mount("/setup?step=sender", {
      sender: { name: "Đã lưu", address: "a@acme.vn", companyAddressLine: "Địa chỉ đã lưu 123", unsubscribeMailto: "u@acme.vn", source: "ui" },
    });
    await waitFor(() => expect((screen.getByLabelText(/^Tên người gửi/) as HTMLInputElement).value).toBe("Đã lưu"));
    change(/^Tên người gửi/, "Tên mới");
    expect(screen.getByRole("button", { name: /Lưu & tiếp tục/ })).toBeTruthy();

    // Free navigation asks first; staying keeps the edit.
    fireEvent.click(step(/^Email/));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Bước này có thay đổi chưa lưu/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ở lại" }));
    expect((screen.getByLabelText(/^Tên người gửi/) as HTMLInputElement).value).toBe("Tên mới");

    // Back + discard.
    fireEvent.click(screen.getByRole("button", { name: /Quay lại/ }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Bỏ thay đổi/ }));
    expect(await screen.findByRole("heading", { name: /3\. Email/ })).toBeTruthy();
    expect(w.calls.putSender).toBeUndefined();

    // Forward again: edit, Tiếp tục saves and advances.
    fireEvent.click(step(/^Người gửi/));
    await waitFor(() => expect((screen.getByLabelText(/^Tên người gửi/) as HTMLInputElement).value).toBe("Đã lưu"));
    change(/^Tên người gửi/, "Tên mới");
    fireEvent.click(screen.getByRole("button", { name: /Lưu & tiếp tục/ }));
    await waitFor(() => expect(w.calls.putSender).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: /5\. Agent SDR/ })).toBeTruthy();
  });
});
