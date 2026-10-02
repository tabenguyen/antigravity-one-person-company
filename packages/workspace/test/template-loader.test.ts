import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTemplate, listTemplateRoles } from "../src/index.ts";

const templatesRoot = path.resolve(import.meta.dirname, "../../../templates");

describe("loadTemplate", () => {
  it("loads and validates the sales-sdr template", () => {
    const t = loadTemplate(templatesRoot, "sales-sdr");
    expect(t.role).toBe("sales-sdr");
    expect(t.defaultModel).toBeTruthy();
    expect(t.policy.builtins.length).toBeGreaterThan(0);
    expect(t.policy.mcp.some((m) => m.server === "company" && m.tool === "kb_search")).toBe(true);
    expect(t.policy.mcp.some((m) => m.tool === "outbox_draft_email")).toBe(true);
    expect(t.taskKinds.map((k) => k.kind).sort()).toEqual(
      ["sdr.first_touch", "sdr.follow_up", "sdr.handle_reply", "sdr.pipeline_review", "sdr.research_lead"].sort(),
    );
    expect(t.hasRules).toBe(true);
    expect(t.hasSkills).toBe(true);
    expect(t.hasKb).toBe(true);
    expect(t.resultSchema).toMatchObject({ type: "object" });
  });

  it("loads the account-manager stub template", () => {
    const t = loadTemplate(templatesRoot, "account-manager");
    expect(t.role).toBe("account-manager");
    expect(t.taskKinds.length).toBeGreaterThanOrEqual(1);
  });

  it("discovers all templates with listTemplateRoles", () => {
    const roles = listTemplateRoles(templatesRoot);
    expect(roles).toContain("sales-sdr");
    expect(roles).toContain("account-manager");
  });

  it("throws for an unknown role", () => {
    expect(() => loadTemplate(templatesRoot, "nonexistent-role")).toThrow(/Template directory not found/);
  });
});

describe("loadTemplate validation failures", () => {
  let scratchRoot: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-tpl-invalid-"));
    fs.cpSync(path.join(templatesRoot, "sales-sdr"), path.join(scratchRoot, "sales-sdr"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("rejects a template.json whose role does not match the directory name", () => {
    const jsonPath = path.join(scratchRoot, "sales-sdr/template.json");
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    data.role = "something-else";
    fs.writeFileSync(jsonPath, JSON.stringify(data));
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/does not match template directory/);
  });

  it("rejects malformed JSON in template.json", () => {
    fs.writeFileSync(path.join(scratchRoot, "sales-sdr/template.json"), "{ not json");
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/not valid JSON/);
  });

  it("rejects a template.json missing required fields", () => {
    fs.writeFileSync(path.join(scratchRoot, "sales-sdr/template.json"), JSON.stringify({ role: "sales-sdr" }));
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/failed validation/);
  });

  it("requires AGENTS.md to exist", () => {
    fs.rmSync(path.join(scratchRoot, "sales-sdr/AGENTS.md"));
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/AGENTS\.md not found/);
  });

  it("requires agent.md to exist", () => {
    fs.rmSync(path.join(scratchRoot, "sales-sdr/agent.md"));
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/agent\.md not found/);
  });

  it("requires the resultSchema file to exist", () => {
    fs.rmSync(path.join(scratchRoot, "sales-sdr/result-schema.json"));
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/resultSchema file not found/);
  });

  it("requires the resultSchema file to be valid JSON", () => {
    fs.writeFileSync(path.join(scratchRoot, "sales-sdr/result-schema.json"), "not json");
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/not valid JSON/);
  });

  it("requires every taskKind's prompt file to exist", () => {
    fs.rmSync(path.join(scratchRoot, "sales-sdr/prompts/research_lead.md"));
    expect(() => loadTemplate(scratchRoot, "sales-sdr")).toThrow(/Prompt file for task kind "sdr.research_lead"/);
  });
});
