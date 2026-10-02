import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createAgent, rerender, rerenderAll } from "../src/provision.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

describe("provision.createAgent", () => {
  it("renders a workspace with the role's policy and the agent's own model", () => {
    const config = makeTestConfig();
    const db = openTestDb();

    const agent = createAgent(
      { config, db },
      { id: "sdr-01", role: "sales-sdr", displayName: "Mai" },
    );

    expect(agent.id).toBe("sdr-01");
    expect(agent.model).toBe("gemini-3.8-flash-medium"); // template defaultModel
    expect(agent.policy.builtins).toContain("view_file");
    expect(agent.workspacePath).toBe(path.join(config.workspacesRoot, "sdr-01"));

    expect(fs.existsSync(path.join(agent.workspacePath, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(agent.workspacePath, ".agents/agents/sales-sdr.md"))).toBe(true);
    expect(fs.existsSync(path.join(agent.workspacePath, ".agents/hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(agent.workspacePath, ".agents/mcp_config.json"))).toBe(true);

    const agentMd = fs.readFileSync(path.join(agent.workspacePath, ".agents/agents/sales-sdr.md"), "utf8");
    expect(agentMd).toContain("Mai");

    db.close();
  });

  it("rejects invalid ids and duplicate ids", () => {
    const config = makeTestConfig();
    const db = openTestDb();
    expect(() => createAgent({ config, db }, { id: "Bad ID!", role: "sales-sdr", displayName: "x" })).toThrow();
    createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai" });
    expect(() => createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai 2" })).toThrow();
    db.close();
  });

  it("rerender re-renders an existing agent's workspace from its current template", () => {
    const config = makeTestConfig();
    const db = openTestDb();
    const agent = createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai" });
    fs.rmSync(path.join(agent.workspacePath, "AGENTS.md"));
    expect(fs.existsSync(path.join(agent.workspacePath, "AGENTS.md"))).toBe(false);
    rerender({ config, db }, "sdr-01");
    expect(fs.existsSync(path.join(agent.workspacePath, "AGENTS.md"))).toBe(true);
    db.close();
  });

  it("rerenderAll re-renders every registered agent", () => {
    const config = makeTestConfig();
    const db = openTestDb();
    createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai" });
    createAgent({ config, db }, { id: "sdr-02", role: "sales-sdr", displayName: "Linh" });
    const results = rerenderAll({ config, db });
    expect(results).toEqual([
      { agentId: "sdr-01", ok: true },
      { agentId: "sdr-02", ok: true },
    ]);
    db.close();
  });
});
