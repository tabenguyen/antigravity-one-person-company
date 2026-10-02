import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createAgent } from "../src/provision.ts";
import { syncKb } from "../src/kb-ingest.ts";
import { makeTestConfig, makeTempDataDir, openTestDb } from "./helpers.ts";

describe("kb-ingest.syncKb", () => {
  it("ingests company, role and agent KB layers and substitutes {{companyName}}", () => {
    const dataDir = makeTempDataDir();
    const kbRoot = path.join(dataDir, "company-kb");
    fs.mkdirSync(kbRoot, { recursive: true });
    fs.writeFileSync(path.join(kbRoot, "pricing.md"), "# Pricing\n\n{{companyName}} charges $10/mo.");

    const config = makeTestConfig({ dataDir, kbRoot });
    const db = openTestDb();
    const agent = createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai" });

    // sales-sdr template ships its own kb/*.md (role scope) — agent kb/ dir is optional.
    fs.mkdirSync(path.join(agent.workspacePath, "kb"), { recursive: true });
    fs.writeFileSync(path.join(agent.workspacePath, "kb", "notes.md"), "Mai's personal note about a lead.");

    const summary = syncKb({ config, db });
    expect(summary.scanned).toBeGreaterThan(0);

    const companyDocs = db.kb.listDocuments("company");
    expect(companyDocs).toHaveLength(1);
    expect(companyDocs[0]!.body).toContain("Test Co charges $10/mo");

    const roleDocs = db.kb.listDocuments("role:sales-sdr" as never);
    expect(roleDocs.length).toBeGreaterThan(0); // templates/sales-sdr/kb/*.md

    const agentDocs = db.kb.listDocuments(`agent:${agent.id}` as never);
    expect(agentDocs).toHaveLength(1);
    expect(agentDocs[0]!.body).toContain("Mai's personal note");

    const hits = db.kb.search("pricing", ["company"], 5);
    expect(hits.length).toBeGreaterThan(0);

    db.close();
  });

  it("deletes documents whose source file disappeared", () => {
    const dataDir = makeTempDataDir();
    const kbRoot = path.join(dataDir, "company-kb");
    fs.mkdirSync(kbRoot, { recursive: true });
    const filePath = path.join(kbRoot, "temp.md");
    fs.writeFileSync(filePath, "temporary doc");

    const config = makeTestConfig({ dataDir, kbRoot });
    const db = openTestDb();

    syncKb({ config, db });
    expect(db.kb.listDocuments("company")).toHaveLength(1);

    fs.rmSync(filePath);
    const summary = syncKb({ config, db });
    expect(summary.deleted).toBeGreaterThanOrEqual(1);
    expect(db.kb.listDocuments("company")).toHaveLength(0);

    db.close();
  });
});
