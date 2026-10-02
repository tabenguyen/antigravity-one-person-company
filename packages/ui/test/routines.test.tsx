// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RoutinesPage } from "../src/pages/Routines/RoutinesPage.tsx";
import { AuthProvider } from "../src/auth/AuthContext.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { describeSchedule, nextRuns, validateSchedule } from "../src/pages/Routines/cron.ts";
import { ok, fail } from "./testUtils.ts";

const AGENTS = [{ id: "sdr-01", displayName: "Mai", role: "sales-sdr", status: "active", trustTier: "shadow" }];

const routine = (over: Record<string, unknown> = {}) => ({
  id: "rtn_1",
  agentId: "sdr-01",
  kind: "prospecting",
  name: "Morning prospecting",
  schedule: "0 9 * * 1-5",
  timezone: "Asia/Ho_Chi_Minh",
  config: { batchSize: 5, stages: ["new"] },
  enabled: true,
  lastRunAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  nextRunAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
  lastResult: "queued 5 research tasks (12 eligible)",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

const evalRun = (over: Record<string, unknown> = {}) => ({
  id: "evr_1",
  suite: "sales-sdr",
  model: "gemini-3.8-flash-medium",
  status: "done",
  startedAt: "2026-10-01T10:00:00.000Z",
  finishedAt: "2026-10-01T10:05:30.000Z",
  summary: { total: 2, pass: 1, fail: 1, error: 0, skipped: 0 },
  results: [
    { caseId: "reply-price", status: "pass", durationMs: 41_000, assertions: [{ name: "result.status == needs_human", ok: true, detail: "actual: needs_human" }], output: { taskStatus: "waiting_approval" } },
    {
      caseId: "reply-vi",
      status: "fail",
      durationMs: 62_000,
      assertions: [
        { name: "outbox.count == 1", ok: true, detail: "actual: 1" },
        { name: "draft.contains /[à-ỹ]/i", ok: false, detail: "not found in any draft" },
      ],
      output: { drafts: [{ body: "Hello" }] },
    },
  ],
  ...over,
});

const SUITES = [
  {
    name: "sales-sdr",
    defaultModel: "gemini-3.8-flash-medium",
    cases: [
      { id: "reply-price", description: "price question", kind: "sdr.handle_reply" },
      { id: "reply-vi", description: "vietnamese", kind: "sdr.handle_reply" },
      { id: "research-out-of-icp", description: "out of icp", kind: "sdr.research_lead" },
    ],
  },
];

interface State {
  routines: ReturnType<typeof routine>[];
  runs: ReturnType<typeof evalRun>[];
  calls: { method: string; path: string; body: any }[];
}

function setup(initial: Partial<State> = {}) {
  const state: State = { routines: [routine()], runs: [evalRun()], calls: [], ...initial };
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") state.calls.push({ method, path, body });

    if (method === "GET" && path === "/v1/admin/routines") return ok({ routines: state.routines });
    if (method === "GET" && path === "/v1/admin/agents") return ok({ agents: AGENTS });
    if (method === "GET" && path === "/v1/admin/evals/suites") return ok({ suites: SUITES });
    if (method === "GET" && path === "/v1/admin/evals") return ok({ runs: state.runs });
    if (method === "POST" && path === "/v1/admin/routines") {
      if (body.name === "explode") return fail("invalid_request", "task kind \"x\" is not defined by the sales-sdr template", 400);
      const created = routine({ id: "rtn_new", ...body, lastRunAt: null, lastResult: null });
      state.routines.push(created);
      return ok({ routine: created });
    }
    const m = /^\/v1\/admin\/routines\/([^/]+)(\/run)?$/.exec(path);
    if (m) {
      const r = state.routines.find((x) => x.id === m[1])!;
      if (method === "PATCH") return ok({ routine: Object.assign(r, body) });
      if (method === "DELETE") {
        state.routines = state.routines.filter((x) => x.id !== m[1]);
        return ok({ deleted: true });
      }
      if (method === "POST" && m[2]) return ok({ routine: Object.assign(r, { lastResult: "queued 3 research tasks (9 eligible)" }) });
    }
    if (method === "POST" && path === "/v1/admin/evals") {
      const run = evalRun({ id: "evr_new", status: "running", finishedAt: null, summary: null, results: [], model: body.model ?? "gemini-3.8-flash-medium" });
      state.runs.unshift(run);
      return ok({ run });
    }
    throw new Error(`No mock route for ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const utils = render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <RoutinesPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { state, ...utils };
}

describe("RoutinesPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists routines with schedule in words, next/last run, last result and the enabled state", async () => {
    setup();
    const row = (await screen.findByText("Morning prospecting")).closest("tr")!;
    expect(within(row).getByText("Weekdays at 09:00")).toBeTruthy();
    expect(within(row).getByText("Mai")).toBeTruthy();
    expect(within(row).getByText("queued 5 research tasks (12 eligible)")).toBeTruthy();
    expect(within(row).getByText(/^in \d+h$/)).toBeTruthy();
    expect((within(row).getByLabelText("Enable Morning prospecting") as HTMLInputElement).checked).toBe(true);
  });

  it("toggles enabled, runs now, and deletes after confirmation", async () => {
    const { state } = setup();
    await screen.findByText("Morning prospecting");

    fireEvent.click(screen.getByLabelText("Enable Morning prospecting"));
    await waitFor(() => expect(state.calls).toContainEqual({ method: "PATCH", path: "/v1/admin/routines/rtn_1", body: { enabled: false } }));

    fireEvent.click(screen.getByLabelText("Run Morning prospecting now"));
    await waitFor(() => expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/admin/routines/rtn_1/run")).toBe(true));
    expect((await screen.findAllByText("queued 3 research tasks (9 eligible)")).length).toBeGreaterThan(0); // toast and/or table row

    fireEvent.click(screen.getByLabelText("Delete Morning prospecting"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete routine" }));
    await waitFor(() => expect(state.calls).toContainEqual({ method: "DELETE", path: "/v1/admin/routines/rtn_1", body: undefined }));
    await screen.findByText(/No routines yet/);
  });

  it("creates a routine: preset schedule, live next-3-runs preview, kind-specific config", async () => {
    const { state } = setup({ routines: [] });
    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog", { name: "New routine" });

    // preview for the default preset (weekdays 09:00) shows exactly 3 upcoming runs, in the routine's timezone
    const preview = within(dialog).getByRole("list", { name: "Next runs" });
    expect(within(preview).getAllByRole("listitem")).toHaveLength(3);
    expect(preview.textContent).toMatch(/09:00/);

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Morning prospecting" } });
    fireEvent.change(within(dialog).getByLabelText("Batch size (leads per run, max 25)"), { target: { value: "8" } });
    fireEvent.click(within(dialog).getByLabelText("nurture"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create routine" }));

    await waitFor(() => expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/admin/routines")).toBe(true));
    expect(state.calls.find((c) => c.method === "POST")!.body).toEqual({
      agentId: "sdr-01",
      kind: "prospecting",
      name: "Morning prospecting",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Ho_Chi_Minh",
      config: { batchSize: 8, stages: ["new", "nurture"] },
      enabled: true,
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New routine" })).toBeNull());
    expect(await screen.findByText("Morning prospecting")).toBeTruthy();
  });

  it("custom schedule: validates the cron live and blocks saving an invalid one", async () => {
    const { state } = setup({ routines: [] });
    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog", { name: "New routine" });
    fireEvent.change(within(dialog).getByLabelText("Schedule"), { target: { value: "custom" } });
    fireEvent.change(within(dialog).getByLabelText(/Cron expression/), { target: { value: "*/15 * * * *" } });
    expect(within(within(dialog).getByRole("list", { name: "Next runs" })).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.change(within(dialog).getByLabelText(/Cron expression/), { target: { value: "61 * * * *" } });
    expect((await within(dialog).findAllByRole("alert"))[0]!.textContent).toMatch(/minute: value 61 is out of range/);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create routine" }));
    expect(state.calls).toHaveLength(0);
  });

  it("custom_task config and server-side validation errors are shown in the form", async () => {
    setup({ routines: [] });
    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog", { name: "New routine" });
    fireEvent.change(within(dialog).getByLabelText("Kind"), { target: { value: "custom_task" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "explode" } });
    fireEvent.change(within(dialog).getByLabelText("Task title"), { target: { value: "Weekly nudge" } });
    fireEvent.change(within(dialog).getByLabelText("Task input (JSON)"), { target: { value: "{not json" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create routine" }));
    expect((await within(dialog).findAllByRole("alert")).some((a) => /valid JSON/.test(a.textContent ?? ""))).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Task input (JSON)"), { target: { value: '{"note":"hi"}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create routine" }));
    expect((await within(dialog).findAllByRole("alert")).some((a) => /not defined by the sales-sdr template/.test(a.textContent ?? ""))).toBe(true);
  });

  it("edits an existing routine", async () => {
    const { state } = setup();
    fireEvent.click(await screen.findByLabelText("Edit Morning prospecting"));
    const dialog = await screen.findByRole("dialog", { name: "Edit routine" });
    expect((within(dialog).getByLabelText("Agent") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Schedule"), { target: { value: "daily-830" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save routine" }));
    await waitFor(() => expect(state.calls.some((c) => c.method === "PATCH" && c.body.schedule === "30 8 * * *")).toBe(true));
  });

  it("shows eval run history with pass/fail counts and duration", async () => {
    setup();
    const row = (await screen.findByLabelText("Open eval run evr_1")) as HTMLElement;
    expect(within(row).getByText("sales-sdr")).toBeTruthy();
    expect(within(row).getByText("gemini-3.8-flash-medium")).toBeTruthy();
    expect(within(row).getByText("1 pass")).toBeTruthy();
    expect(within(row).getByText("1 fail")).toBeTruthy();
    expect(within(row).getByText("5m 30s")).toBeTruthy();
  });

  it("opens the detail drawer with per-case assertions (✓/✗ + detail) and output JSON", async () => {
    setup();
    fireEvent.click(await screen.findByLabelText("Open eval run evr_1"));
    const drawer = await screen.findByRole("dialog", { name: "Eval run details" });
    const failing = within(drawer).getByTestId("eval-case-reply-vi");
    expect(within(failing).getByText("FAIL")).toBeTruthy();
    const items = within(within(failing).getByRole("list", { name: "Assertions for reply-vi" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByLabelText("passed").textContent).toBe("✓");
    expect(within(items[1]!).getByLabelText("failed").textContent).toBe("✗");
    expect(within(items[1]!).getByText("not found in any draft")).toBeTruthy();
    expect(within(failing).getByText(/"drafts"/)).toBeTruthy(); // output JSON
    expect(within(drawer).getByText("1 passed")).toBeTruthy();

    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Eval run details" })).toBeNull());
  });

  it("starts an eval run for the chosen cases and opens it", async () => {
    const { state } = setup({ runs: [] });
    await screen.findByLabelText("reply-price");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gemini-3.8-flash-high" } });
    fireEvent.click(screen.getByLabelText("research-out-of-icp")); // deselect one
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/admin/evals")).toBe(true));
    expect(state.calls.find((c) => c.path === "/v1/admin/evals")!.body).toEqual({
      suite: "sales-sdr",
      model: "gemini-3.8-flash-high",
      caseIds: ["reply-price", "reply-vi"],
    });
    const drawer = await screen.findByRole("dialog", { name: "Eval run details" });
    expect(within(drawer).getByText(/Running — 0 case/)).toBeTruthy();
    // a run in progress disables starting another
    expect((screen.getByRole("button", { name: /Run in progress/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("starting with every case selected omits caseIds (run the whole suite)", async () => {
    const { state } = setup({ runs: [] });
    await screen.findByLabelText("reply-price");
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(state.calls.some((c) => c.path === "/v1/admin/evals")).toBe(true));
    expect(state.calls.find((c) => c.path === "/v1/admin/evals")!.body).toEqual({ suite: "sales-sdr" });
  });
});

describe("cron helper in the browser bundle", () => {
  it("is the daemon's implementation", () => {
    expect(describeSchedule("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(validateSchedule("* * * * *", "UTC")).toEqual({ ok: true });
    expect(nextRuns("0 9 * * 1-5", "Asia/Ho_Chi_Minh", new Date("2026-10-01T01:00:00Z"), 2).map((d) => d.toISOString())).toEqual([
      "2026-10-01T02:00:00.000Z",
      "2026-10-02T02:00:00.000Z",
    ]);
  });
});
