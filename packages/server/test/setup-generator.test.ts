import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeneratedSetup, SetupJob } from "../src/admin-types.ts";
import { SETUP_JOBS_KEY, MAX_JOBS, SetupJobManager } from "../src/setup/jobs.ts";
import { validateGenerated } from "../src/setup/schema.ts";
import { EventBus } from "../src/event-bus.ts";
import { buildSetupEnv, type SetupEnv } from "./setup-helpers.ts";
import { makeTempDataDir, makeTestConfig, openTestDb, waitFor } from "./helpers.ts";

const FAKE = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures/fake-setup-agy.mjs");

const kbBody = (title: string) =>
  `# ${title}\n\nSources: https://acme.example/pricing\n\n${"Acme Logistics syncs inventory across Shopee, Lazada and the shop's own store. ".repeat(4)}\n`;

function validResult(): Record<string, unknown> {
  return {
    profile: {
      companyName: "Acme Logistics",
      website: "https://acme.example",
      oneLiner: "Inventory sync for multi-channel sellers in Vietnam.",
      productDescription: "Acme keeps stock levels in sync across Shopee, Lazada and your own store in near real time.",
      targetCustomers: "Vietnamese e-commerce retailers selling on two or more channels.",
      painPoints: "- Overselling when stock runs out on one channel\n- Manual end-of-day reconciliation",
      differentiators: "",
      pricingPolicy: "Starter 500.000đ/month (excl. VAT) per https://acme.example/pricing. Never quote anything else.",
      proofPoints: "",
      forbiddenClaims: "- Never promise zero overselling\n- Never claim it supports all marketplaces",
      meetingLink: null,
      languages: ["vi", "en"],
    },
    roleKb: {
      files: [
        { relPath: "icp.md", title: "ICP", body: kbBody("ICP") },
        { relPath: "sales-playbook.md", title: "Playbook", body: kbBody("Playbook") },
        { relPath: "objection-handling.md", title: "Objections", body: kbBody("Objections") },
      ],
    },
    suggestedSender: { name: "Acme Sales", address: "sales@acme.example", companyAddressLine: "Acme Ltd, 1 Nguyen Hue, HCMC", unsubscribeMailto: null },
    sources: [{ url: "https://acme.example/", title: "Home" }],
    conflicts: ["Pricing: acme.example/pricing says 500.000đ but old.acme.example says 300.000đ"],
    openQuestions: ["No booking link published"],
  };
}

let tmp: string;
let scriptPath: string;
let logPath: string;
let t: SetupEnv;

function script(turns: unknown[]) {
  fs.writeFileSync(scriptPath, JSON.stringify({ turns }));
  fs.rmSync(`${scriptPath}.count`, { force: true });
}
const invocations = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  tmp = makeTempDataDir();
  scriptPath = path.join(tmp, "script.json");
  logPath = path.join(tmp, "log.jsonl");
  process.env.FAKE_SETUP_SCRIPT = scriptPath;
  process.env.FAKE_SETUP_LOG = logPath;
  t = buildSetupEnv({
    config: { agyBin: FAKE },
    deps: { setupOverrides: { dnsCheck: false, brainRoot: path.join(tmp, "brain") } },
  });
});
afterEach(async () => {
  await t.deps.setupJobs!.abortAll();
  delete process.env.FAKE_SETUP_SCRIPT;
  delete process.env.FAKE_SETUP_LOG;
});

async function settle(id: string): Promise<SetupJob> {
  await t.deps.setupJobs!.waitFor(id);
  return (await t.call("GET", `/v1/admin/setup/generate/${id}`)).body.data.job;
}

describe("POST /v1/admin/setup/generate", () => {
  it("runs the researcher through agy, forwards progress, validates and stores the result", async () => {
    script([{ kind: "ok", structured: validResult() }]);
    const start = await t.call("POST", "/v1/admin/setup/generate", {
      domain: "https://Acme.Example/pricing?x=1",
      extraUrls: ["https://acme.example/faq"],
      notes: "pricing on /pricing is current",
      language: "en",
    });
    expect(start.status).toBe(200);
    const job0 = start.body.data.job as SetupJob;
    expect(job0).toMatchObject({ domain: "acme.example", status: "running", result: null, error: null });
    expect(job0.model).toBe("gemini-3.8-flash-medium");

    const job = await settle(job0.id);
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    const result = job.result as GeneratedSetup;
    expect(result.profile.companyName).toBe("Acme Logistics");
    expect(result.roleKb.role).toBe("sales-sdr");
    expect(result.roleKb.files.map((f) => f.relPath)).toEqual(["icp.md", "sales-playbook.md", "objection-handling.md"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.sources).toEqual([{ url: "https://acme.example/", title: "Home" }]);
    expect(job.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(job.finishedAt).toBeTruthy();

    // progress: one readable line per step, never raw JSON
    const lines = job.progress.map((p) => p.line);
    expect(lines).toContain("Reading https://acme.example/");
    expect(lines).toContain("Reading a saved page");
    expect(lines.some((l) => /^Tool: run_command failed: tool call denied/.test(l))).toBe(true); // a gate denial is visible
    expect(lines).toContain("Agent: Reading pricing now");
    expect(lines.filter((l) => l === "Reading https://acme.example/")).toHaveLength(1); // ACTIVE+DONE collapse into one line
    expect(lines.at(-1)).toMatch(/^Done: 1 source/);

    // the invocation: dedicated agent + workspace, json schema, model, prompt content
    const [call] = invocations();
    expect(call.argv).toEqual(expect.arrayContaining(["--agent", "company-researcher", "--model", "gemini-3.8-flash-medium", "--json-schema"]));
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(path.join(t.config.dataDir, "setup-workspace")));
    const prompt = JSON.parse(call.stdin).message.content as string;
    expect(prompt).toContain("https://acme.example");
    expect(prompt).toContain("https://acme.example/faq");
    expect(prompt).toContain("pricing on /pricing is current");
    expect(prompt).toMatch(/English/);
    expect(prompt).toMatch(/conflicts/);
    expect(prompt).toMatch(/at most 12 pages/);
    expect(prompt).toMatch(/salesPlaybook/);
    expect(prompt).toMatch(/SHORT brand name/);
    expect(prompt).toMatch(/ONLY what https:\/\/acme\.example itself states/);

    // the researcher workspace is the locked-down one
    const ws = path.join(t.config.dataDir, "setup-workspace");
    expect(fs.existsSync(path.join(ws, ".agents", "hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".agents", "mcp_config.json"))).toBe(false);

    // events + persistence
    const updates = t.events.filter((e) => e.type === "setup.job.updated").map((e) => e.data["status"]);
    expect(updates).toEqual(["running", "done"]);
    expect(t.events.filter((e) => e.type === "setup.job.progress").length).toBe(job.progress.length);
    expect((t.db.kv.get(SETUP_JOBS_KEY) as { jobs: SetupJob[] }).jobs[0]!.status).toBe("done");

    // list / get / cancel-of-finished / unknown id
    const list = await t.call("GET", "/v1/admin/setup/generate");
    expect(list.body.data.jobs.map((j: SetupJob) => j.id)).toEqual([job.id]);
    expect((await t.call("POST", `/v1/admin/setup/generate/${job.id}/cancel`)).body.data.job.status).toBe("done");
    expect((await t.call("GET", "/v1/admin/setup/generate/setup_nope")).status).toBe(404);
    expect((await t.call("POST", "/v1/admin/setup/generate/setup_nope/cancel")).status).toBe(404);
  });

  it("validates the request", async () => {
    expect((await t.call("POST", "/v1/admin/setup/generate", { domain: "not a domain" })).status).toBe(400);
    expect((await t.call("POST", "/v1/admin/setup/generate", {})).status).toBe(400);
    expect((await t.call("POST", "/v1/admin/setup/generate", { domain: "a.com", extraUrls: ["nope"] })).status).toBe(400);
    expect((await t.app.request("/v1/admin/setup/generate", { method: "POST" })).status).toBe(401);
  });

  it("allows one running job at a time (409), cancel kills agy, then a new job can start", async () => {
    script([{ kind: "hang" }, { kind: "ok", structured: validResult() }]);
    const first = (await t.call("POST", "/v1/admin/setup/generate", { domain: "acme.example", model: "gemini-3.8-flash-high" })).body.data.job as SetupJob;
    expect(first.model).toBe("gemini-3.8-flash-high");
    await waitFor(() => invocations().length === 1, 5000);

    const second = await t.call("POST", "/v1/admin/setup/generate", { domain: "other.example" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict");

    const cancelled = await t.call("POST", `/v1/admin/setup/generate/${first.id}/cancel`);
    expect(cancelled.body.data.job).toMatchObject({ status: "cancelled", result: null });
    const done = await settle(first.id);
    expect(done.status).toBe("cancelled");
    expect(done.error).toMatch(/cancel/);
    expect(t.events.filter((e) => e.type === "setup.job.updated").map((e) => e.data["status"])).toEqual(["running", "cancelled"]);

    const next = await t.call("POST", "/v1/admin/setup/generate", { domain: "acme.example" });
    expect(next.status).toBe(200);
    expect((await settle(next.body.data.job.id)).status).toBe("done");
    // newest first
    expect((await t.call("GET", "/v1/admin/setup/generate")).body.data.jobs.map((j: SetupJob) => j.id)).toEqual([next.body.data.job.id, first.id]);
  });

  it("a validation failure triggers ONE repair turn that resumes the same conversation with the exact errors", async () => {
    const bad = validResult() as any;
    bad.profile.pricingPolicy = "TODO fill in the price list from the website";
    bad.roleKb.files = bad.roleKb.files.slice(0, 2); // objection-handling.md missing
    script([{ kind: "ok", structured: bad }, { kind: "ok", structured: validResult() }]);
    const job0 = (await t.call("POST", "/v1/admin/setup/generate", { domain: "acme.example" })).body.data.job as SetupJob;
    const job = await settle(job0.id);
    expect(job.status).toBe("done");
    expect(job.usage).toEqual({ inputTokens: 200, outputTokens: 100 }); // both turns counted

    const calls = invocations();
    expect(calls).toHaveLength(2);
    expect(calls[1].argv).toEqual(expect.arrayContaining(["--conversation", "fake-setup-conv-0001", "--agent", "company-researcher"]));
    const repair = JSON.parse(calls[1].stdin).message.content as string;
    expect(repair).toMatch(/profile\.pricingPolicy: contains placeholder text \(TODO\)/);
    expect(repair).toMatch(/missing required file objection-handling\.md/);
    expect(job.progress.map((p) => p.line).some((l) => /asking the agent to repair/.test(l))).toBe(true);
  });

  it("fails with a clear error when the repair is still invalid (no third turn)", async () => {
    const bad = validResult() as any;
    bad.profile.oneLiner = "short";
    script([{ kind: "ok", structured: bad }]); // the same bad answer for every turn
    const job = await settle(((await t.call("POST", "/v1/admin/setup/generate", { domain: "acme.example" })).body.data.job as SetupJob).id);
    expect(job.status).toBe("failed");
    expect(job.result).toBeNull();
    expect(job.error).toMatch(/still invalid after one repair/);
    expect(job.error).toMatch(/profile\.oneLiner/);
    expect(invocations()).toHaveLength(2);
  });

  it("a missing structured result gets one repair turn; an agy error fails immediately", async () => {
    script([{ kind: "no_structured" }, { kind: "ok", structured: validResult() }]);
    const a = await settle(((await t.call("POST", "/v1/admin/setup/generate", { domain: "acme.example" })).body.data.job as SetupJob).id);
    expect(a.status).toBe("done");
    expect(invocations()).toHaveLength(2);

    fs.rmSync(logPath);
    script([{ kind: "error", message: "model quota exhausted" }]);
    const b = await settle(((await t.call("POST", "/v1/admin/setup/generate", { domain: "acme.example" })).body.data.job as SetupJob).id);
    expect(b).toMatchObject({ status: "failed" });
    expect(b.error).toMatch(/model quota exhausted/);
    expect(invocations()).toHaveLength(1);
  });

  it("recovers a result the agent wrote as JSON text (finish rejected), tolerating the shapes models actually produce", async () => {
    const odd = validResult() as any;
    odd.profile.differentiators = ["Shared quota across the whole period", "No per-user fees"]; // list where a string is expected
    odd.conflicts = [{ detail: "Pricing: /pricing says 500.000đ but old.acme.example says 300.000đ" }]; // object instead of string
    odd.openQuestions = [{ question: "Is there a booking link?" }, "  "];
    odd.roleKb = { icp: kbBody("ICP"), salesPlaybook: kbBody("Playbook"), objectionHandling: kbBody("Objections") }; // flat form
    script([{ kind: "no_structured", text: "Here you go:\n```json\n" + JSON.stringify(odd) + "\n```" }]);
    const job = await settle(((await t.call("POST", "/v1/admin/setup/generate", { domain: "acme.example" })).body.data.job as SetupJob).id);
    expect(job.status).toBe("done");
    expect(invocations()).toHaveLength(1); // no repair turn needed
    const r = job.result as GeneratedSetup;
    expect(r.profile.differentiators).toBe("- Shared quota across the whole period\n- No per-user fees");
    expect(r.conflicts).toEqual(["Pricing: /pricing says 500.000đ but old.acme.example says 300.000đ"]);
    expect(r.openQuestions).toEqual(["Is there a booking link?"]);
    expect(r.roleKb.files.map((f) => f.relPath)).toEqual(["icp.md", "sales-playbook.md", "objection-handling.md"]);
    expect(job.progress.some((p) => /JSON text instead of finish/.test(p.line))).toBe(true);
  });

  it("abortAll (daemon shutdown) winds a hung job down and marks it cancelled", async () => {
    script([{ kind: "hang" }]);
    const manager = new SetupJobManager({ config: t.config, db: openTestDb(), bus: new EventBus(), dnsCheck: false, brainRoot: path.join(tmp, "brain"), timeoutMs: 1000 });
    const job = manager.start({ domain: "acme.example", extraUrls: [], language: "vi" });
    await waitFor(() => invocations().length === 1, 5000);
    await manager.abortAll();
    expect(manager.get(job.id)).toMatchObject({ status: "cancelled", error: "daemon shutting down" });
  });
});

describe("job persistence", () => {
  it("running jobs from a previous process are marked failed on startup; only the last 20 are kept", () => {
    const db = openTestDb();
    const stale: SetupJob = { id: "setup_old", domain: "a.com", model: "m", status: "running", startedAt: "2026-01-01T00:00:00Z", finishedAt: null, progress: [{ at: "x", line: "Reading" }], result: null, error: null, usage: null };
    const finished: SetupJob = { ...stale, id: "setup_done", status: "done" };
    db.kv.set(SETUP_JOBS_KEY, { jobs: [stale, finished] });
    const manager = new SetupJobManager({ config: makeTestConfig(), db, bus: new EventBus() });
    const jobs = manager.list();
    expect(jobs[0]).toMatchObject({ id: "setup_old", status: "failed", error: "daemon restarted before the research finished" });
    expect(jobs[0]!.finishedAt).toBeTruthy();
    expect(jobs[1]!.status).toBe("done");
    expect((db.kv.get(SETUP_JOBS_KEY) as { jobs: SetupJob[] }).jobs[0]!.status).toBe("failed"); // persisted
  });

  it("keeps at most 20 jobs", async () => {
    const db = openTestDb();
    const v = validateGenerated(validResult());
    if (!v.ok) throw new Error(v.errors.join(";"));
    const generate = async () => ({ setup: v.setup, usage: { inputTokens: 1, outputTokens: 1 }, conversationId: null, repaired: false, fetchedUrls: [] });
    const manager = new SetupJobManager({ config: makeTestConfig(), db, bus: new EventBus(), generate });
    for (let i = 0; i < MAX_JOBS + 3; i++) {
      const j = manager.start({ domain: `d${i}.com`, extraUrls: [], language: "vi" });
      await manager.waitFor(j.id);
    }
    expect(manager.list()).toHaveLength(MAX_JOBS);
    expect(manager.list()[0]!.domain).toBe(`d${MAX_JOBS + 2}.com`);
    expect((db.kv.get(SETUP_JOBS_KEY) as { jobs: SetupJob[] }).jobs).toHaveLength(MAX_JOBS);
  });
});

describe("validateGenerated", () => {
  it("accepts a good result and normalises it", () => {
    const r = validateGenerated(validResult());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.setup.profile.languages).toEqual(["vi", "en"]);
      expect(r.setup.suggestedSender.unsubscribeMailto).toBeNull();
    }
  });

  it("collects every problem: schema, placeholders anywhere, missing/short/duplicate KB files, bad sources", () => {
    const bad = validResult() as any;
    bad.profile.painPoints = "";
    bad.profile.forbiddenClaims = "Your Company never lies";
    bad.roleKb.files = [
      { relPath: "icp.md", title: "ICP", body: "# ICP\n\nEXAMPLE — a fake customer\n" + "x".repeat(300) },
      { relPath: "sales-playbook.md", title: "x", body: "too short" },
      { relPath: "sales-playbook.md", title: "x", body: "y".repeat(300) },
      { relPath: "../evil.md", title: "x", body: "z".repeat(300) },
    ];
    bad.sources = [{ url: "javascript:alert(1)", title: null }];
    const r = validateGenerated(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.errors.join("\n");
      expect(all).toMatch(/profile\.painPoints/);
      expect(all).toMatch(/profile\.forbiddenClaims: contains placeholder text \(Your Company\)/);
      expect(all).toMatch(/icp\.md\)?: placeholder text on line 3 \(EXAMPLE —\)/);
      expect(all).toMatch(/too short/);
      expect(all).toMatch(/duplicate relPath/);
      expect(all).toMatch(/relPath must look like/);
      expect(all).toMatch(/roleKb\.objectionHandling: missing required file objection-handling\.md/);
      expect(all).toMatch(/sources: "javascript:alert\(1\)" is not an http\(s\) URL/);
    }
    expect(validateGenerated({}).ok).toBe(false);
    expect(validateGenerated(null).ok).toBe(false);
  });

  it("drops an invalid suggested sender address instead of failing the whole result", () => {
    const r = validResult() as any;
    r.suggestedSender = { name: " ", address: "not-an-email", companyAddressLine: null, unsubscribeMailto: "mailto:stop@acme.example" };
    const v = validateGenerated(r);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.setup.suggestedSender).toEqual({ name: null, address: null, companyAddressLine: null, unsubscribeMailto: "stop@acme.example" });
      expect(v.warnings.join(" ")).toMatch(/not a valid email/);
    }
  });
});
