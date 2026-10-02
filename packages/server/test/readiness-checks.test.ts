import { describe, it, expect } from "vitest";
import type { CompanyProfile, ReadinessReport } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { computeReadiness, type VerifyResult } from "../src/readiness/checks.ts";
import { saveCompanyProfile } from "../src/readiness/company.ts";
import { findPlaceholder, placeholderMarkers } from "../src/readiness/placeholders.ts";
import type { AgyhqConfig } from "../src/config.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

const PROFILE: CompanyProfile = {
  companyName: "Acme",
  website: "https://acme.io",
  oneLiner: "Inventory sync for multi-channel sellers.",
  productDescription: "Acme syncs stock across marketplaces in real time.",
  targetCustomers: "E-commerce retailers with 2+ channels.",
  painPoints: "- Overselling\n- Manual reconciliation",
  differentiators: "",
  pricingPolicy: "Never quote prices; offer a call.",
  proofPoints: "",
  forbiddenClaims: "",
  meetingLink: null,
  languages: ["vi", "en"],
  updatedAt: new Date().toISOString(),
};

function readyConfig(overrides: Partial<AgyhqConfig> = {}): AgyhqConfig {
  return makeTestConfig({
    email: { kind: "imap-smtp", pollIntervalMs: 60_000 } as AgyhqConfig["email"],
    sender: { name: "Acme Sales", address: "mai@acme.io", companyAddressLine: "Acme Ltd, 1 Nguyen Hue, Ho Chi Minh City" },
    unsubscribeMailto: "unsubscribe@acme.io",
    ...overrides,
  });
}

function seedReady(db: Db, config: AgyhqConfig) {
  saveCompanyProfile(db, PROFILE);
  db.kb.upsertDocument({ scope: "company", title: "Product", sourcePath: `${config.kbRoot}/company/product.md`, body: "# Product\nAcme syncs stock." });
  db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] }, trustTier: "shadow" });
  db.settings.patch({ defaultSdrAgentId: "sdr-01" });
}

const VERIFY_OK = async (): Promise<VerifyResult> => ({ ok: true });

async function run(db: Db, config: AgyhqConfig, verifyEmail: () => Promise<VerifyResult> = VERIFY_OK): Promise<ReadinessReport> {
  return computeReadiness({ config, db, verifyEmail });
}

const byId = (r: ReadinessReport, id: string) => r.checks.find((c) => c.id === id)!;

describe("placeholder detection", () => {
  it("flags every marker with line number", () => {
    expect(findPlaceholder("ok\n> **EXAMPLE — replace**")).toMatchObject({ line: 2, marker: "EXAMPLE —" });
    expect(findPlaceholder("a\nb\n- TODO — fill in")).toMatchObject({ line: 3, marker: "TODO" });
    expect(findPlaceholder("price: TBD")?.marker).toBe("TBD");
    expect(findPlaceholder("Lorem ipsum dolor")?.marker).toBe("lorem ipsum");
    expect(findPlaceholder("Hello {{companyName}}")?.marker).toBe("{{placeholder}}");
    expect(findPlaceholder("Welcome to Your Company")?.marker).toBe("Your Company");
  });

  it("does not flag clean English or Vietnamese text", () => {
    const vi = [
      "# Giới thiệu sản phẩm",
      "Chúng tôi cung cấp phần mềm quản lý tồn kho đa kênh cho các cửa hàng Shopee, Lazada và TikTok Shop.",
      "Khách hàng mục tiêu: chủ cửa hàng có từ 2 kênh bán hàng trở lên.",
      "Không bao giờ hứa hẹn giảm giá hoặc khuyến mãi chưa được duyệt.",
      "Cần làm rõ nhu cầu của khách trước khi đề nghị cuộc gọi.",
      "Improve your company's sales; for example - use shared stock. Todo lists are out of scope.",
    ].join("\n");
    expect(findPlaceholder(vi)).toBeNull();
    expect(placeholderMarkers("Tổng đài ĐỒNG TODOÂ")).toEqual([]);
  });
});

describe("computeReadiness", () => {
  it("is ready (no fails) with a fully configured system", async () => {
    const config = readyConfig();
    const db = openTestDb();
    seedReady(db, config);
    const report = await run(db, config);
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      "company.profile",
      "kb.company_present",
      "kb.no_placeholders",
      "sender.identity",
      "unsubscribe.mailto",
      "email.provider",
      "email.verified",
      "agents.sdr_present",
      "agents.trust",
      "settings.default_sdr",
      "settings.quiet_hours",
      "settings.rate",
      "quota",
    ]);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(Number.isNaN(Date.parse(report.at))).toBe(false);
  });

  it("fresh system fails the setup checks with actionable details", async () => {
    const config = makeTestConfig({ sender: { name: "Your Company Sales", address: "sdr@yourcompany.com", companyAddressLine: "Your Company, 123 Main St" }, unsubscribeMailto: "unsubscribe@yourcompany.com" });
    const db = openTestDb();
    const report = await run(db, config);
    expect(report.ready).toBe(false);
    for (const id of ["company.profile", "kb.company_present", "sender.identity", "unsubscribe.mailto", "email.provider", "email.verified", "agents.sdr_present"]) {
      const c = byId(report, id);
      expect(c.status, id).toBe("fail");
      expect(c.detail.length, id).toBeGreaterThan(10);
      expect(c.fixPath, id).toMatch(/^\//);
    }
    expect(byId(report, "settings.default_sdr").status).toBe("warn");
    expect(byId(report, "kb.no_placeholders").status).toBe("pass"); // nothing indexed => nothing to flag
  });

  it("company.profile: pass when saved", async () => {
    const config = readyConfig();
    const db = openTestDb();
    expect(byId(await run(db, config), "company.profile").status).toBe("fail");
    saveCompanyProfile(db, PROFILE);
    expect(byId(await run(db, config), "company.profile").status).toBe("pass");
  });

  it("kb.no_placeholders lists files and the first offending line, company and role scopes only", async () => {
    const config = readyConfig();
    const db = openTestDb();
    seedReady(db, config);
    db.kb.upsertDocument({ scope: "role:sales-sdr", title: "ICP", sourcePath: "/t/sales-sdr/kb/icp.md", body: "# ICP\n\n> **EXAMPLE — replace this**\n- TODO — x" });
    db.kb.upsertDocument({ scope: "agent:sdr-01", title: "Notes", sourcePath: "/w/sdr-01/kb/n.md", body: "TODO scratch notes are fine here" });
    const c = byId(await run(db, config), "kb.no_placeholders");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("role:sales-sdr/icp.md");
    expect(c.detail).toContain("line 3");
    expect(c.detail).toContain("EXAMPLE");
    expect(c.detail).not.toContain("scratch");
    expect(c.fixPath).toBe("/knowledge");

    db.kb.upsertDocument({ scope: "company", title: "Bad", sourcePath: `${config.kbRoot}/company/bad.md`, body: "Pricing: TBD" });
    const c2 = byId(await run(db, config), "kb.no_placeholders");
    expect(c2.detail).toContain("2 knowledge base file(s)");
    expect(c2.detail).toContain("company/bad.md");
  });

  it("kb.no_placeholders passes Vietnamese content", async () => {
    const config = readyConfig();
    const db = openTestDb();
    seedReady(db, config);
    db.kb.upsertDocument({ scope: "company", title: "Sản phẩm", sourcePath: `${config.kbRoot}/company/vi.md`, body: "# Sản phẩm\nPhần mềm đồng bộ tồn kho. Không hứa hẹn giá chưa duyệt." });
    expect(byId(await run(db, config), "kb.no_placeholders").status).toBe("pass");
  });

  it("kb.company_present fails without company docs", async () => {
    const config = readyConfig();
    const db = openTestDb();
    expect(byId(await run(db, config), "kb.company_present").status).toBe("fail");
    seedReady(db, config);
    expect(byId(await run(db, config), "kb.company_present").status).toBe("pass");
  });

  it("sender.identity and unsubscribe.mailto fail on defaults/missing and pass on real values", async () => {
    const db = openTestDb();
    const cases: [Partial<AgyhqConfig>, string, string][] = [
      [{ sender: { name: "Your Company Sales", address: "mai@acme.io", companyAddressLine: "Acme, 1 St" } }, "sender.identity", "fail"],
      [{ sender: { name: "Acme", address: "sdr@yourcompany.com", companyAddressLine: "Acme, 1 St" } }, "sender.identity", "fail"],
      [{ sender: { name: "Acme", address: "mai@acme.io", companyAddressLine: "Your Company, 123 Main St, City" } }, "sender.identity", "fail"],
      [{ sender: { name: "Acme", address: "mai@acme.io", companyAddressLine: "Acme, 123 Main St" } }, "sender.identity", "fail"],
      [{ sender: { name: "Acme", address: "", companyAddressLine: "Acme, 1 St" } }, "sender.identity", "fail"],
      [{ sender: { name: "Acme", address: "not-an-email", companyAddressLine: "Acme, 1 St" } }, "sender.identity", "fail"],
      [{ sender: { name: "Acme", address: "mai@acme.io", companyAddressLine: "" } }, "sender.identity", "fail"],
      [{ sender: { name: "Acme", address: "mai@acme.io", companyAddressLine: "Acme, 1 Nguyễn Huệ, TP.HCM" } }, "sender.identity", "pass"],
      [{ unsubscribeMailto: "" }, "unsubscribe.mailto", "fail"],
      [{ unsubscribeMailto: "unsubscribe@yourcompany.com" }, "unsubscribe.mailto", "fail"],
      [{ unsubscribeMailto: "nope" }, "unsubscribe.mailto", "fail"],
      [{ unsubscribeMailto: "mailto:stop@acme.io" }, "unsubscribe.mailto", "pass"],
    ];
    for (const [override, id, expected] of cases) {
      const report = await run(db, readyConfig(override));
      expect(byId(report, id).status, JSON.stringify(override)).toBe(expected);
    }
  });

  it("email.provider and email.verified", async () => {
    const db = openTestDb();
    const none = await run(db, readyConfig({ email: { kind: "none", pollIntervalMs: 1 } }));
    expect(byId(none, "email.provider").status).toBe("fail");
    expect(byId(none, "email.verified").status).toBe("fail");

    const maildir = await run(db, readyConfig({ email: { kind: "maildir", root: "/x", address: "a@b.co", pollIntervalMs: 1 } as AgyhqConfig["email"] }));
    expect(byId(maildir, "email.provider").status).toBe("warn");
    expect(byId(maildir, "email.provider").detail).toMatch(/development/i);
    expect(byId(maildir, "email.verified").status).toBe("pass");

    const bad = await run(db, readyConfig(), async () => ({ ok: false, error: "AUTH failed" }));
    expect(byId(bad, "email.verified").status).toBe("fail");
    expect(byId(bad, "email.verified").detail).toContain("AUTH failed");

    const throws = await run(db, readyConfig(), async () => {
      throw new Error("socket hang up");
    });
    expect(byId(throws, "email.verified").detail).toContain("socket hang up");
  });

  it("agents checks", async () => {
    const config = readyConfig();
    const db = openTestDb();
    expect(byId(await run(db, config), "agents.sdr_present").status).toBe("fail");

    db.agents.create({ id: "sdr-paused", role: "sales-sdr", displayName: "P", model: "m", workspacePath: "/tmp/p", policy: { builtins: [], mcp: [] }, status: "paused" });
    expect(byId(await run(db, config), "agents.sdr_present").status).toBe("fail");

    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/s", policy: { builtins: [], mcp: [] }, trustTier: "autonomous" });
    const r = await run(db, config);
    expect(byId(r, "agents.sdr_present").status).toBe("pass");
    expect(byId(r, "agents.trust").status).toBe("warn");
    expect(byId(r, "agents.trust").detail).toContain("sdr-01");
    expect(byId(r, "settings.default_sdr").status).toBe("warn");

    db.settings.patch({ defaultSdrAgentId: "ghost" });
    expect(byId(await run(db, config), "settings.default_sdr").status).toBe("warn");
    db.settings.patch({ defaultSdrAgentId: "sdr-01" });
    expect(byId(await run(db, config), "settings.default_sdr").status).toBe("pass");
  });

  it("settings checks: quiet hours and rate", async () => {
    const config = readyConfig();
    const db = openTestDb();
    expect(byId(await run(db, config), "settings.quiet_hours").status).toBe("pass");
    db.settings.patch({ quietHours: null, sendRatePerHour: 51 });
    const r = await run(db, config);
    expect(byId(r, "settings.quiet_hours").status).toBe("warn");
    expect(byId(r, "settings.rate").status).toBe("warn");
    db.settings.patch({ sendRatePerHour: 50 });
    expect(byId(await run(db, config), "settings.rate").status).toBe("pass");
  });

  it("quota warns when any bucket is below 20%", async () => {
    const config = readyConfig();
    const db = openTestDb();
    expect(byId(await run(db, config), "quota").status).toBe("pass");
    db.quota.record([
      { group: "Gemini Models", window: "weekly", remainingFraction: 0.8, resetTime: null },
      { group: "Claude", window: "5h", remainingFraction: 0.19, resetTime: null },
    ]);
    const q = byId(await run(db, config), "quota");
    expect(q.status).toBe("warn");
    expect(q.detail).toContain("Claude");
    db.quota.record([{ group: "Gemini Models", window: "weekly", remainingFraction: 0.2, resetTime: null }]);
    expect(byId(await run(db, config), "quota").status).toBe("pass");
  });

  it("warnings never block readiness", async () => {
    const config = readyConfig({ email: { kind: "maildir", root: "/x", address: "a@b.co", pollIntervalMs: 1 } as AgyhqConfig["email"] });
    const db = openTestDb();
    seedReady(db, config);
    db.settings.patch({ quietHours: null, sendRatePerHour: 500 });
    const r = await run(db, config);
    expect(r.checks.some((c) => c.status === "warn")).toBe(true);
    expect(r.ready).toBe(true);
  });
});
