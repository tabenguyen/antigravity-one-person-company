import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { serve, type ServerType } from "@hono/node-server";
import { FakeEmailProvider } from "@agyhq/channels";
import type { CompanyProfile, ReadinessReport } from "@agyhq/core";
import { createAdminApi, EventBus, openDbForTest } from "./setupHarness.ts";
import {
  cmdReadiness,
  cmdSetup,
  createLineReader,
  formatReadiness,
  parseSetupCompanyArgs,
  promptCompanyProfile,
  readProfileFile,
  type LineReader,
} from "../src/commands/setup.ts";

function scripted(answers: string[]): LineReader & { prompts: string[] } {
  const queue = [...answers];
  const prompts: string[] = [];
  return {
    prompts,
    async ask(prompt) {
      prompts.push(prompt);
      return queue.length ? queue.shift()! : null;
    },
    close() {},
  };
}

describe("parseSetupCompanyArgs", () => {
  it("parses --file / -f and --help", () => {
    expect(parseSetupCompanyArgs([])).toEqual({ file: null, help: false });
    expect(parseSetupCompanyArgs(["--file", "p.json"])).toEqual({ file: "p.json", help: false });
    expect(parseSetupCompanyArgs(["--file=p.json"]).file).toBe("p.json");
    expect(parseSetupCompanyArgs(["-f", "x.json"]).file).toBe("x.json");
    expect(parseSetupCompanyArgs(["--help"]).help).toBe(true);
  });

  it("rejects unknown flags, positionals and a missing --file value", () => {
    expect(() => parseSetupCompanyArgs(["--bogus"])).toThrow(/usage: hq setup company/);
    expect(() => parseSetupCompanyArgs(["stray"])).toThrow();
    expect(() => parseSetupCompanyArgs(["--file"])).toThrow();
    expect(() => parseSetupCompanyArgs(["--file", " "])).toThrow(/needs a path/);
  });
});

describe("readProfileFile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-setup-"));
  it("reads JSON objects and explains failures", () => {
    const good = path.join(dir, "good.json");
    fs.writeFileSync(good, '{"companyName":"Acme"}');
    expect(readProfileFile(good)).toEqual({ companyName: "Acme" });
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{nope");
    expect(() => readProfileFile(bad)).toThrow(/not valid JSON/);
    const arr = path.join(dir, "arr.json");
    fs.writeFileSync(arr, "[]");
    expect(() => readProfileFile(arr)).toThrow(/JSON object/);
    expect(() => readProfileFile(path.join(dir, "missing.json"))).toThrow(/cannot read/);
  });
});

describe("formatReadiness", () => {
  const report: ReadinessReport = {
    ready: false,
    at: new Date().toISOString(),
    checks: [
      { id: "company.profile", title: "Company profile saved", status: "fail", detail: "No profile.", fixPath: "/setup#company" },
      { id: "settings.quiet_hours", title: "Quiet hours enabled", status: "warn", detail: "Off.", fixPath: "/settings" },
      { id: "quota", title: "Model quota headroom", status: "pass", detail: "fine", fixPath: null },
    ],
  };
  it("uses ✓ ! ✗ marks, shows details for non-passing checks only, and summarises", () => {
    const lines = formatReadiness(report);
    expect(lines[0]).toBe("✗ Company profile saved  [company.profile]");
    expect(lines).toContain("    No profile.");
    expect(lines).toContain("    fix: /setup#company");
    expect(lines.some((l) => l.startsWith("! Quiet hours"))).toBe(true);
    expect(lines.some((l) => l.startsWith("✓ Model quota"))).toBe(true);
    expect(lines).not.toContain("    fine");
    expect(lines.at(-1)).toBe("NOT ready: 1 failing check, 1 warning.");
    expect(formatReadiness({ ...report, ready: true, checks: [report.checks[2]!] }).at(-1)).toBe("Ready to enable outbound.");
  });
});

describe("promptCompanyProfile", () => {
  it("collects single-line and multi-line (blank-line terminated) answers", async () => {
    const reader = scripted([
      "Acme", // companyName
      "https://acme.io", // website
      "Inventory sync for sellers.", // oneLiner
      "Line one of product", "line two", "", // productDescription
      "Retailers on 2+ channels", "", // targetCustomers
      "- Overselling", "- Manual work", "", // painPoints
      "", // differentiators (skip)
      "Never quote prices.", "", // pricing
      "", // proof
      "", // forbidden
      "", // meeting link
      "vi, en , ", // languages
    ]);
    const out: string[] = [];
    const body = await promptCompanyProfile(reader, null, (l) => out.push(l));
    expect(body).toEqual({
      companyName: "Acme",
      website: "https://acme.io",
      oneLiner: "Inventory sync for sellers.",
      productDescription: "Line one of product\nline two",
      targetCustomers: "Retailers on 2+ channels",
      painPoints: "- Overselling\n- Manual work",
      differentiators: "",
      pricingPolicy: "Never quote prices.",
      proofPoints: "",
      forbiddenClaims: "",
      meetingLink: null,
      languages: ["vi", "en"],
    });
  });

  it("keeps existing values on empty answers and defaults languages to vi,en; re-asks required fields", async () => {
    const existing = { companyName: "Old Co", oneLiner: "Existing one-liner here.", pricingPolicy: "Existing policy text", productDescription: "Existing description text" } as CompanyProfile;
    const reader = scripted(["", "", "", "", "", "", "", "", "", "", "", "", ""]);
    const body = await promptCompanyProfile(reader, existing, () => {});
    expect(body.companyName).toBe("Old Co");
    expect(body.oneLiner).toBe("Existing one-liner here.");
    expect(body.productDescription).toBe("Existing description text");
    expect(body.languages).toEqual(["vi", "en"]);
    // targetCustomers/painPoints are required and have no value: asked 3 times each, then left empty for the server to reject
    expect(body.targetCustomers).toBe("");
  });

  it("ends cleanly at EOF", async () => {
    const body = await promptCompanyProfile(scripted([]), null, () => {});
    expect(body.companyName).toBe("");
  });
});

describe("createLineReader", () => {
  it("reads piped lines in order, then null at EOF", async () => {
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    const reader = createLineReader(Readable.from(["a\nb\n", "c\n"]), sink);
    expect(await reader.ask("? ")).toBe("a");
    expect(await reader.ask("? ")).toBe("b");
    expect(await reader.ask("? ")).toBe("c");
    expect(await reader.ask("? ")).toBeNull();
    reader.close();
  });
});

describe("commands against a live admin API", () => {
  let server: ServerType;
  let url: string;
  let cwd: string;
  let token: string;
  let provider: FakeEmailProvider;
  let dbHandle: ReturnType<typeof openDbForTest>;

  beforeAll(async () => {
    process.env.AGYHQ_ADMIN_TOKEN = "cli-test-token";
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hq-cli-setup-"));
    token = "cli-test-token";
    dbHandle = openDbForTest();
    provider = new FakeEmailProvider();
    const templates = path.join(cwd, "templates");
    fs.mkdirSync(templates);
    const app = createAdminApi({
      config: dbHandle.makeConfig({ adminToken: token, kbRoot: path.join(cwd, "kb"), templatesRoot: templates }),
      db: dbHandle.db,
      bus: new EventBus(),
      emailProvider: provider,
    });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    });
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env.AGYHQ_ADMIN_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const globals = () => ({ url, token, cwd, json: false });

  it("hq readiness prints the checklist and sets exit code 1 when not ready", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    await cmdReadiness([], globals());
    expect(logs.some((l) => l.startsWith("✗ Company profile saved"))).toBe(true);
    expect(logs.at(-1)).toMatch(/^NOT ready/);
    expect(process.exitCode).toBe(1);
  });

  it("hq readiness --json prints the report", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    await cmdReadiness([], { ...globals(), json: true });
    expect((JSON.parse(logs.join("\n")) as ReadinessReport).checks.length).toBeGreaterThan(5);
  });

  it("hq setup company --file saves the profile and lists written files", async () => {
    const file = path.join(cwd, "profile.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        companyName: "Acme",
        oneLiner: "Inventory sync for sellers.",
        productDescription: "Acme keeps stock levels in sync across channels.",
        targetCustomers: "Retailers on two or more channels.",
        painPoints: "- Overselling\n- Manual reconciliation",
        pricingPolicy: "Never quote prices; offer a call.",
      }),
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    await cmdSetup(["company", "--file", file], globals());
    expect(logs[0]).toBe("Saved company profile for Acme.");
    expect(logs.some((l) => l.includes("company/product.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "kb/company/product.md"))).toBe(true);
  });

  it("hq setup email-test reports success and failure (exit code 1)", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    await cmdSetup(["email-test"], globals());
    expect(logs[0]).toMatch(/^✓ email connection OK/);
    expect(process.exitCode).toBeUndefined();

    provider.setVerify({ ok: false, error: "bad password" });
    await cmdSetup(["email-test"], globals());
    expect(logs[1]).toBe("✗ email connection failed: bad password");
    expect(process.exitCode).toBe(1);
  });

  it("--help prints usage without calling the daemon", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    await cmdSetup(["--help"], { url: "http://127.0.0.1:1", token: "x", cwd, json: false });
    await cmdSetup(["company", "--help"], { url: "http://127.0.0.1:1", token: "x", cwd, json: false });
    await cmdSetup(["email-test", "--help"], { url: "http://127.0.0.1:1", token: "x", cwd, json: false });
    await cmdReadiness(["--help"], { url: "http://127.0.0.1:1", token: "x", cwd, json: false });
    expect(logs[0]).toContain("usage: hq setup");
    expect(logs[1]).toContain("--file");
    expect(logs[2]).toContain("email-test");
    expect(logs[3]).toContain("usage: hq readiness");
  });
});
