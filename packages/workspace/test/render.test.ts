import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTemplate, renderWorkspace, parseFrontmatter } from "../src/index.ts";
import { makeAgent, makeVars } from "./helpers.ts";

const realTemplatesRoot = path.resolve(import.meta.dirname, "../../../templates");

describe("renderWorkspace (sales-sdr)", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-ws-"));
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("writes the expected file tree", () => {
    const template = loadTemplate(realTemplatesRoot, "sales-sdr");
    const agent = makeAgent({ policy: template.policy, workspacePath: outDir });
    const result = renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars: makeVars() });

    expect(result.files).toEqual(
      [
        "AGENTS.md",
        ".agents/agents/sales-sdr.md",
        ".agents/hooks.json",
        ".agents/mcp_config.json",
        ".agents/rules/compliance.md",
        ".agents/rules/human-voice.md",
        ".agents/rules/objection-handling.md",
        ".agents/rules/pricing-and-discounts.md",
        ".agents/rules/voice-and-tone.md",
        ".agents/skills/follow-up-sequence/SKILL.md",
        ".agents/skills/handle-reply/SKILL.md",
        ".agents/skills/log-to-crm/SKILL.md",
        ".agents/skills/qualify-lead/SKILL.md",
        ".agents/skills/research-lead/SKILL.md",
        ".agents/skills/write-first-touch/SKILL.md",
      ]
        .map((p) => path.join(...p.split("/")))
        .sort(),
    );
    for (const rel of result.files) {
      expect(fs.existsSync(path.join(outDir, rel)), `${rel} should exist on disk`).toBe(true);
    }
  });

  it("renders .agents/agents/<role>.md frontmatter from the agent instance, not the template defaults", () => {
    const template = loadTemplate(realTemplatesRoot, "sales-sdr");
    const customPolicy = { builtins: ["view_file"], mcp: template.policy.mcp };
    const agent = makeAgent({ policy: customPolicy, model: "claude-sonnet-5", displayName: "Lan", workspacePath: outDir });
    renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars: makeVars({ companyName: "Acme" }) });

    const raw = fs.readFileSync(path.join(outDir, ".agents/agents/sales-sdr.md"), "utf8");
    const { data, body } = parseFrontmatter(raw, "test");
    expect(data.name).toBe("sales-sdr");
    expect(data.tools).toEqual(["view_file", "finish"]); // finish is always added (agy needs it listed for --json-schema runs)
    expect(data.model).toBe("claude-sonnet-5");
    expect(typeof data.description).toBe("string");
    expect(body).toContain("Lan");
    expect(body).toContain("Acme");
  });

  it("renders AGENTS.md with placeholders substituted", () => {
    const template = loadTemplate(realTemplatesRoot, "sales-sdr");
    const agent = makeAgent({ policy: template.policy, displayName: "Mai", workspacePath: outDir });
    renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars: makeVars({ companyName: "Makini" }) });
    const content = fs.readFileSync(path.join(outDir, "AGENTS.md"), "utf8");
    expect(content).toContain("Mai");
    expect(content).toContain("Makini");
    expect(content).not.toMatch(/\{\{.*\}\}/);
  });

  it("produces hooks.json matching the exact contract (matchers, scripts, timeouts)", () => {
    const template = loadTemplate(realTemplatesRoot, "sales-sdr");
    const agent = makeAgent({ policy: template.policy, workspacePath: outDir });
    const vars = makeVars({ nodeBin: "/opt/homebrew/bin/node", hooksDistDir: "/opt/agyhq/hooks-dist" });
    renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars });

    const hooks = JSON.parse(fs.readFileSync(path.join(outDir, ".agents/hooks.json"), "utf8"));
    const bundle = hooks.agyhq;
    expect(bundle.PreToolUse).toEqual([
      {
        matcher: ".*",
        hooks: [
          {
            type: "command",
            command: '"/opt/homebrew/bin/node" "/opt/agyhq/hooks-dist/pre-tool-use.mjs"',
            timeout: 10,
          },
        ],
      },
    ]);
    expect(bundle.PostToolUse).toEqual([
      {
        matcher: ".*",
        hooks: [
          {
            type: "command",
            command: '"/opt/homebrew/bin/node" "/opt/agyhq/hooks-dist/audit.mjs" PostToolUse',
            timeout: 5,
          },
        ],
      },
    ]);
    expect(bundle.PreInvocation).toEqual([
      { type: "command", command: '"/opt/homebrew/bin/node" "/opt/agyhq/hooks-dist/context.mjs"', timeout: 10 },
    ]);
    expect(bundle.PostInvocation).toEqual([
      {
        type: "command",
        command: '"/opt/homebrew/bin/node" "/opt/agyhq/hooks-dist/audit.mjs" PostInvocation',
        timeout: 5,
      },
    ]);
    expect(bundle.Stop).toEqual([
      { type: "command", command: '"/opt/homebrew/bin/node" "/opt/agyhq/hooks-dist/stop.mjs"', timeout: 10 },
    ]);
  });

  it("produces mcp_config.json with server key 'company' and no secrets (env inherited from the agy process)", () => {
    const template = loadTemplate(realTemplatesRoot, "sales-sdr");
    const agent = makeAgent({ policy: template.policy, workspacePath: outDir });
    const vars = makeVars({ nodeBin: "/usr/bin/node", mcpEntry: "/opt/agyhq/mcp/company-mcp.mjs" });
    renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars });

    const mcp = JSON.parse(fs.readFileSync(path.join(outDir, ".agents/mcp_config.json"), "utf8"));
    expect(mcp).toEqual({
      mcpServers: {
        company: { command: "/usr/bin/node", args: ["/opt/agyhq/mcp/company-mcp.mjs"] },
      },
    });
  });

  it("throws on an unknown placeholder and writes nothing partial for that file's siblings being relied upon", () => {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-tpl-"));
    fs.cpSync(path.join(realTemplatesRoot, "sales-sdr"), path.join(scratchRoot, "sales-sdr"), { recursive: true });
    fs.writeFileSync(path.join(scratchRoot, "sales-sdr/AGENTS.md"), "Hello {{totallyUnknownVar}}");
    const template = loadTemplate(scratchRoot, "sales-sdr");
    const agent = makeAgent({ policy: template.policy, workspacePath: outDir });
    expect(() => renderWorkspace({ agent, template, templatesRoot: scratchRoot, outDir, vars: makeVars() })).toThrow(
      /Unknown placeholder \{\{totallyUnknownVar\}\}/,
    );
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("is idempotent: re-rendering with the same inputs produces the same file set and content", () => {
    const template = loadTemplate(realTemplatesRoot, "sales-sdr");
    const agent = makeAgent({ policy: template.policy, workspacePath: outDir });
    const vars = makeVars();
    const r1 = renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars });
    const snapshot1 = Object.fromEntries(r1.files.map((f) => [f, fs.readFileSync(path.join(outDir, f), "utf8")]));
    const r2 = renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars });
    const snapshot2 = Object.fromEntries(r2.files.map((f) => [f, fs.readFileSync(path.join(outDir, f), "utf8")]));
    expect(r2.files).toEqual(r1.files);
    expect(snapshot2).toEqual(snapshot1);
  });

  it("removes files no longer in the template on re-render, but never touches files outside .agents/ and AGENTS.md", () => {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-tpl-"));
    fs.cpSync(path.join(realTemplatesRoot, "sales-sdr"), path.join(scratchRoot, "sales-sdr"), { recursive: true });
    const template1 = loadTemplate(scratchRoot, "sales-sdr");
    const agent = makeAgent({ policy: template1.policy, workspacePath: outDir });
    const vars = makeVars();
    renderWorkspace({ agent, template: template1, templatesRoot: scratchRoot, outDir, vars });

    expect(fs.existsSync(path.join(outDir, ".agents/skills/follow-up-sequence/SKILL.md"))).toBe(true);

    // Plant files renderWorkspace must never touch.
    fs.mkdirSync(path.join(outDir, ".agyhq"), { recursive: true });
    fs.writeFileSync(path.join(outDir, ".agyhq/state.json"), "{}");
    fs.writeFileSync(path.join(outDir, "scratch-notes.txt"), "do not delete me");
    // Plant a stray file INSIDE .agents/ that isn't part of any template — must be removed.
    fs.writeFileSync(path.join(outDir, ".agents/stray-from-old-render.md"), "stale");

    // Remove a skill and a rule from the template, then re-render.
    fs.rmSync(path.join(scratchRoot, "sales-sdr/skills/follow-up-sequence"), { recursive: true, force: true });
    fs.rmSync(path.join(scratchRoot, "sales-sdr/rules/voice-and-tone.md"), { force: true });
    const template2 = loadTemplate(scratchRoot, "sales-sdr");
    const result = renderWorkspace({
      agent: { ...agent, policy: template2.policy },
      template: template2,
      templatesRoot: scratchRoot,
      outDir,
      vars,
    });

    expect(fs.existsSync(path.join(outDir, ".agents/skills/follow-up-sequence"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, ".agents/rules/voice-and-tone.md"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, ".agents/stray-from-old-render.md"))).toBe(false);
    expect(result.files.some((f) => f.includes("follow-up-sequence"))).toBe(false);
    expect(result.files.some((f) => f.includes("voice-and-tone"))).toBe(false);

    // Untouched outside .agents/ and AGENTS.md:
    expect(fs.existsSync(path.join(outDir, ".agyhq/state.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "scratch-notes.txt"))).toBe(true);

    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("throws if the agent's role does not match the template's role", () => {
    const template = loadTemplate(realTemplatesRoot, "sales-sdr");
    const agent = makeAgent({ policy: template.policy, role: "account-manager", workspacePath: outDir });
    expect(() => renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars: makeVars() })).toThrow(
      /does not match template role/,
    );
  });
});

describe("renderWorkspace (account-manager stub)", () => {
  it("renders the minimal stub template without error", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-ws-am-"));
    const template = loadTemplate(realTemplatesRoot, "account-manager");
    const agent = makeAgent({
      id: "am-01",
      role: "account-manager",
      policy: template.policy,
      workspacePath: outDir,
    });
    const result = renderWorkspace({ agent, template, templatesRoot: realTemplatesRoot, outDir, vars: makeVars() });
    expect(result.files).toContain(path.join("AGENTS.md"));
    expect(result.files).toContain(path.join(".agents", "agents", "account-manager.md"));
    // Shared rules (templates/_shared/rules/) reach every role, with placeholders rendered.
    const humanVoice = fs.readFileSync(path.join(outDir, ".agents", "rules", "human-voice.md"), "utf8");
    expect(humanVoice).toContain("You are **Mai** in those messages");
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
