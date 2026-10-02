// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReadinessReport } from "@agyhq/core";
import { useState } from "react";
import { CompanyProfileForm } from "../src/pages/Setup/CompanyProfileForm.tsx";
import { ReadinessChecklist, READINESS_TEXTS_VI } from "../src/pages/Setup/ReadinessChecklist.tsx";
import { ToastProvider } from "../src/components/Toast.tsx";
import { fail, installMockEventSource, ok, routeFetch } from "./testUtils.ts";

const NOT_READY: ReadinessReport = {
  ready: false,
  at: new Date().toISOString(),
  checks: [
    { id: "company.profile", title: "Company profile saved", status: "fail", detail: "No company profile yet.", fixPath: "/setup#company" },
    { id: "kb.no_placeholders", title: "Knowledge base has no placeholder text", status: "fail", detail: "2 files contain placeholders.", fixPath: "/knowledge" },
    { id: "settings.quiet_hours", title: "Quiet hours enabled", status: "warn", detail: "Quiet hours are off.", fixPath: "/settings" },
    { id: "quota", title: "Model quota headroom", status: "pass", detail: "Fine.", fixPath: "/dashboard" },
  ],
};
const READY: ReadinessReport = {
  ready: true,
  at: new Date().toISOString(),
  checks: [{ id: "company.profile", title: "Company profile saved", status: "pass", detail: "Saved for Acme.", fixPath: "/setup#company" }],
};

interface Opts {
  readiness?: ReadinessReport;
  profile?: unknown;
  put?: (body: any) => Response;
}

/** Renders the (English, standalone) company form and the checklist side by side, as a host page would. */
function Host({ report, profile }: { report: ReadinessReport; profile: any }) {
  const [tick, setTick] = useState(0);
  return (
    <>
      <ReadinessChecklist report={report} loading={false} error={null} onRecheck={() => setTick(tick + 1)} />
      <CompanyProfileForm profile={profile} loading={false} loadError={null} onSaved={() => {}} />
    </>
  );
}

function setup(opts: Opts = {}) {
  installMockEventSource();
  localStorage.setItem("agyhq_admin_token", "t");
  const putBodies: any[] = [];
  const fetchMock = routeFetch({
    "PUT /v1/admin/setup/company": (_u, init) => {
      const body = JSON.parse(String(init?.body));
      putBodies.push(body);
      return opts.put ? opts.put(body) : ok({ profile: { ...body, differentiators: "", proofPoints: "", forbiddenClaims: "", updatedAt: new Date().toISOString() }, files: ["company/product.md", "company/pricing-policy.md"] });
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  const utils = render(
    <MemoryRouter initialEntries={["/setup"]}>
      <ToastProvider>
        <Host report={opts.readiness ?? NOT_READY} profile={opts.profile ?? null} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { ...utils, fetchMock, putBodies };
}

function fillValid() {
  const set = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  set(/^company name/i, "Acme Logistics");
  set(/^one-liner/i, "Inventory sync for multi-channel sellers.");
  set(/^product description/i, "Acme keeps stock levels in sync across channels in real time.");
  set(/^target customers/i, "Vietnamese e-commerce retailers on two or more channels.");
  set(/^pain points/i, "- Overselling\n- Manual reconciliation");
  set(/^pricing policy/i, "Never quote prices; offer a call.");
}

describe("Setup building blocks (checklist + company form)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders the checklist with status icons, details, fix links and counts", async () => {
    setup();
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(items[0]!).getByRole("img", { name: "Failing" })).toBeTruthy();
    expect(within(items[0]!).getByText("No company profile yet.")).toBeTruthy();
    expect(within(items[2]!).getByRole("img", { name: "Warning" })).toBeTruthy();
    expect(within(items[3]!).getByRole("img", { name: "Passing" })).toBeTruthy();

    const fix = within(items[1]!).getByRole("link", { name: /fix/i });
    expect(fix.getAttribute("href")).toBe("/knowledge");
    expect(within(items[3]!).queryByRole("link")).toBeNull(); // no Fix link on passing checks
    expect(screen.getByText(/2 failing · 1 warning · 1 passing/)).toBeTruthy();
  });

  it("re-check button calls onRecheck", async () => {
    const onRecheck = vi.fn();
    render(
      <MemoryRouter>
        <ReadinessChecklist report={NOT_READY} loading={false} error={null} onRecheck={onRecheck} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /re-check/i }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("resolveFix and texts override the link target and the language", () => {
    render(
      <MemoryRouter>
        <ReadinessChecklist
          report={NOT_READY}
          loading={false}
          error={null}
          onRecheck={() => {}}
          texts={READINESS_TEXTS_VI}
          resolveFix={(c) => (c.id === "company.profile" ? "/setup?step=company" : null)}
        />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole("link", { name: /xử lý/i });
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/setup?step=company", "/knowledge", "/settings"]);
    expect(screen.getByRole("button", { name: /kiểm tra lại/i })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Chưa đạt" })).toHaveLength(2);
  });

  it("company form: helper text, placeholders, and language chips", async () => {
    setup();
    await screen.findByText("No company profile yet.");
    const description = screen.getByLabelText(/^product description/i) as HTMLTextAreaElement;
    expect(description.placeholder).toMatch(/Shopee/);
    expect(description.getAttribute("aria-describedby")).toContain("company-productDescription-help");
    expect(screen.getByText(/only source of truth for product claims/i)).toBeTruthy();
    expect(screen.getByText("vi")).toBeTruthy();
    expect(screen.getByText("en")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /remove language en/i }));
    expect(screen.queryByText("en")).toBeNull();
    const add = screen.getByLabelText(/add language code/i);
    fireEvent.change(add, { target: { value: "ZH" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(screen.getByText("zh")).toBeTruthy();
    fireEvent.change(add, { target: { value: "not a code" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(screen.getByText(/short language code/i)).toBeTruthy();
  });

  it("blocks submit client-side and lists problems when required fields are missing", async () => {
    const { putBodies } = setup();
    await screen.findByText("No company profile yet.");
    fireEvent.change(screen.getByLabelText(/^one-liner/i), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /save company profile/i }));
    expect(await screen.findByText(/Company name is required/)).toBeTruthy();
    expect(screen.getByText(/One-liner must be at least 10 characters/)).toBeTruthy();
    expect(screen.getByRole("alert", { name: "" }) ).toBeTruthy();
    expect(putBodies).toHaveLength(0);
  });

  it("submits a valid profile as CompanyProfileInput, lists written files and re-checks readiness", async () => {
    const { putBodies } = setup();
    await screen.findByText("No company profile yet.");
    fillValid();
    fireEvent.change(screen.getByLabelText(/^website/i), { target: { value: "https://acme.io" } });
    fireEvent.click(screen.getByRole("button", { name: /save company profile/i }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({
      companyName: "Acme Logistics",
      website: "https://acme.io",
      meetingLink: null,
      differentiators: "",
      languages: ["vi", "en"],
    });
    expect(await screen.findByText("company/product.md")).toBeTruthy();
  });

  it("shows the server's validation error and keeps the entered values", async () => {
    setup({ put: () => fail("invalid_request", "pricingPolicy: still contains placeholder text (TODO) — replace it with real content", 400) });
    await screen.findByText("No company profile yet.");
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: /save company profile/i }));
    const alert = await screen.findByText(/pricingPolicy: still contains placeholder text/);
    expect(alert.getAttribute("role")).toBe("alert");
    expect((screen.getByLabelText(/^company name/i) as HTMLInputElement).value).toBe("Acme Logistics");
  });

  it("loads an existing profile into the form", async () => {
    setup({
      profile: {
        companyName: "Saved Co",
        website: "https://saved.io",
        oneLiner: "Saved one-liner for the test.",
        productDescription: "Saved product description that is long enough.",
        targetCustomers: "Saved customers here.",
        painPoints: "- saved pain",
        differentiators: "",
        pricingPolicy: "Saved pricing policy.",
        proofPoints: "",
        forbiddenClaims: "",
        meetingLink: null,
        languages: ["en"],
        updatedAt: new Date().toISOString(),
      },
    });
    await waitFor(() => expect((screen.getByLabelText(/^company name/i) as HTMLInputElement).value).toBe("Saved Co"));
    expect((screen.getByLabelText(/^website/i) as HTMLInputElement).value).toBe("https://saved.io");
    expect(screen.queryByText("vi")).toBeNull();
  });
});
