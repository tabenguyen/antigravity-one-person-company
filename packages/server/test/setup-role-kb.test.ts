import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncKb } from "../src/kb-ingest.ts";
import { computeReadiness } from "../src/readiness/checks.ts";
import { buildSetupEnv } from "./setup-helpers.ts";
import { makeTestConfig, openTestDb, REPO_ROOT } from "./helpers.ts";

const BODY = (title: string) => `# ${title}\n\nReal content for ${title} with enough words to be useful for an agent.\n`;

describe("role KB override ingestion", () => {
  it("kbRoot/roles/<role>/*.md becomes scope role:<role> and the template kb for that role is not ingested (and is pruned)", () => {
    const env = buildSetupEnv({ realTemplates: true });
    const { config, db } = env;
    // 1. template only
    syncKb({ config, db });
    const templateDocs = db.kb.listDocuments("role:sales-sdr");
    expect(templateDocs.length).toBeGreaterThan(0);
    expect(templateDocs.every((d) => d.sourcePath.includes(`${path.sep}templates${path.sep}`))).toBe(true);

    // 2. add an override -> template docs are pruned, override docs appear, nothing leaks into company scope
    const dir = path.join(config.kbRoot, "roles", "sales-sdr");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "icp.md"), BODY("ICP for {{companyName}}"));
    fs.writeFileSync(path.join(dir, "extra.md"), BODY("Extra"));
    syncKb({ config, db });
    const roleDocs = db.kb.listDocuments("role:sales-sdr");
    expect(roleDocs.map((d) => path.basename(d.sourcePath)).sort()).toEqual(["extra.md", "icp.md"]);
    expect(roleDocs.find((d) => d.title.startsWith("ICP"))!.body).toContain(config.companyName); // {{companyName}} substituted
    expect(db.kb.listDocuments("company").some((d) => d.sourcePath.includes(`${path.sep}roles${path.sep}`))).toBe(false);

    // 3. removing the override falls back to the template kb
    fs.rmSync(dir, { recursive: true });
    syncKb({ config, db });
    expect(db.kb.listDocuments("role:sales-sdr").map((d) => d.sourcePath).sort()).toEqual(templateDocs.map((d) => d.sourcePath).sort());
  });

  it("with the NK Invoice example kb (examples/nk-invoice/kb/roles/sales-sdr) readiness kb.no_placeholders passes", async () => {
    const db = openTestDb();
    const config = makeTestConfig({ kbRoot: path.join(REPO_ROOT, "examples", "nk-invoice", "kb"), templatesRoot: path.join(REPO_ROOT, "templates") });
    syncKb({ config, db });
    const roleDocs = db.kb.listDocuments("role:sales-sdr");
    expect(roleDocs.map((d) => path.basename(d.sourcePath)).sort()).toEqual(["icp.md", "objection-handling.md", "sales-playbook.md"]);
    expect(roleDocs.every((d) => d.sourcePath.includes(path.join("kb", "roles", "sales-sdr")))).toBe(true);
    const report = await computeReadiness({ config, db, verifyEmail: async () => ({ ok: true }) });
    const check = report.checks.find((c) => c.id === "kb.no_placeholders")!;
    expect(check.detail).toBeTruthy();
    expect(check.status, check.detail).toBe("pass");
  });
});

describe("GET/PUT /v1/admin/setup/role-kb", () => {
  it("GET reports the template kb until an override exists; validates the role", async () => {
    const env = buildSetupEnv({ realTemplates: true });
    const tpl = await env.call("GET", "/v1/admin/setup/role-kb?role=sales-sdr");
    expect(tpl.status).toBe(200);
    expect(tpl.body.data.source).toBe("template");
    expect(tpl.body.data.files.map((f: any) => f.relPath)).toEqual(["icp.md", "objection-handling.md", "sales-playbook.md"]);
    expect(tpl.body.data.files.some((f: any) => f.hasPlaceholders)).toBe(true); // shipped templates are examples
    expect((await env.call("GET", "/v1/admin/setup/role-kb?role=nope")).status).toBe(400);
    expect((await env.call("GET", "/v1/admin/setup/role-kb")).body.data.role).toBe("sales-sdr"); // default
  });

  it("PUT replaces the directory: writes new files, deletes stale .md, re-syncs, audits, emits", async () => {
    const env = buildSetupEnv({ realTemplates: true });
    const dir = path.join(env.config.kbRoot, "roles", "sales-sdr");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stale.md"), "# Stale\n\nold");
    fs.writeFileSync(path.join(dir, "keep.txt"), "not markdown");

    const put = await env.call("PUT", "/v1/admin/setup/role-kb", {
      role: "sales-sdr",
      files: [
        { relPath: "icp.md", body: BODY("Ideal customer") },
        { relPath: "sales-playbook.md", body: "# Playbook\n\nTODO write this\n" },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.data.source).toBe("override");
    expect(put.body.data.files.map((f: any) => [f.relPath, f.hasPlaceholders])).toEqual([
      ["icp.md", false],
      ["sales-playbook.md", true],
    ]);
    expect(put.body.data.files[0].title).toBe("Ideal customer");
    expect(fs.readdirSync(dir).sort()).toEqual(["icp.md", "keep.txt", "sales-playbook.md"]); // stale.md gone, no tmp files
    expect(env.db.kb.listDocuments("role:sales-sdr").map((d) => path.basename(d.sourcePath)).sort()).toEqual(["icp.md", "sales-playbook.md"]);
    const audit = env.db.audit.list({ kind: ["kb.edited"] })[0]!;
    expect(audit.data).toMatchObject({ scope: "role:sales-sdr", files: ["icp.md", "sales-playbook.md"], removed: ["stale.md"] });
    expect(env.events.some((e) => e.type === "kb.synced")).toBe(true);

    const get = await env.call("GET", "/v1/admin/setup/role-kb?role=sales-sdr");
    expect(get.body.data.source).toBe("override");
    expect(get.body.data.files).toHaveLength(2);

    // the generic KB file editor now targets the override directory for that role
    const doc = env.db.kb.listDocuments("role:sales-sdr")[0]!;
    const viaDocs = await env.call("GET", `/v1/admin/kb/docs/${doc.id}`);
    expect(viaDocs.status).toBe(200);
    expect(JSON.stringify(viaDocs.body.data)).toContain(`${path.sep}roles${path.sep}sales-sdr${path.sep}`);
  });

  it("PUT validates paths and bodies (traversal, extension, duplicates, empty, unknown role)", async () => {
    const env = buildSetupEnv();
    const bad = async (files: unknown, role = "sales-sdr") => (await env.call("PUT", "/v1/admin/setup/role-kb", { role, files })).status;
    expect(await bad([{ relPath: "../evil.md", body: "x" }])).toBe(400);
    expect(await bad([{ relPath: "sub/evil.md", body: "x" }])).toBe(400);
    expect(await bad([{ relPath: "evil.txt", body: "x" }])).toBe(400);
    expect(await bad([{ relPath: "a.md", body: "" }])).toBe(400);
    expect(await bad([])).toBe(400);
    expect(await bad([{ relPath: "a.md", body: "x" }, { relPath: "A.md", body: "y" }])).toBe(400);
    expect(await bad([{ relPath: "a.md", body: "x" }], "ceo")).toBe(400);
    expect(fs.existsSync(path.join(env.config.kbRoot, "roles"))).toBe(false); // nothing written for rejected requests
    expect((await env.app.request("/v1/admin/setup/role-kb")).status).toBe(401);
  });
});
