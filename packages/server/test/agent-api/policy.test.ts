import { describe, expect, it } from "vitest";
import type { ToolPolicy } from "@agyhq/core";
import { evaluatePolicy } from "../../src/agent-api/policy.ts";

const POLICY: ToolPolicy = {
  builtins: ["view_file", "list_dir"],
  mcp: [
    { server: "company", tool: "kb_search" },
    { server: "company", tool: "crm_find_contact" },
  ],
};

const WILDCARD_POLICY: ToolPolicy = {
  builtins: [],
  mcp: [{ server: "company", tool: "*" }],
};

describe("evaluatePolicy — builtins", () => {
  it("allows a listed builtin", () => {
    expect(evaluatePolicy(POLICY, "view_file", {})).toEqual({ decision: "allow" });
  });

  it("denies an unlisted builtin, with a reason naming the tool and listing allowed ones", () => {
    const decision = evaluatePolicy(POLICY, "run_command", {});
    expect(decision.decision).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("run_command");
    expect((decision as { reason: string }).reason).toContain("view_file");
  });

  it("default-denies with an empty policy", () => {
    const decision = evaluatePolicy({ builtins: [], mcp: [] }, "view_file", {});
    expect(decision.decision).toBe("deny");
  });

  it("denies an empty toolName", () => {
    expect(evaluatePolicy(POLICY, "", {}).decision).toBe("deny");
  });
});

describe("evaluatePolicy — call_mcp_tool", () => {
  it("allows an exact {server, tool} match", () => {
    const decision = evaluatePolicy(POLICY, "call_mcp_tool", { ServerName: "company", ToolName: "kb_search", Arguments: {} });
    expect(decision).toEqual({ decision: "allow" });
  });

  it("denies a tool not in the allow-list for that server", () => {
    const decision = evaluatePolicy(POLICY, "call_mcp_tool", { ServerName: "company", ToolName: "outbox_draft_email", Arguments: {} });
    expect(decision.decision).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("company/outbox_draft_email");
  });

  it("denies a server not in the allow-list at all", () => {
    const decision = evaluatePolicy(POLICY, "call_mcp_tool", { ServerName: "other", ToolName: "kb_search", Arguments: {} });
    expect(decision.decision).toBe("deny");
  });

  it("wildcard tool '*' allows any tool on that server", () => {
    expect(evaluatePolicy(WILDCARD_POLICY, "call_mcp_tool", { ServerName: "company", ToolName: "anything_at_all" }).decision).toBe(
      "allow",
    );
  });

  it("wildcard on one server does not leak to another server", () => {
    expect(evaluatePolicy(WILDCARD_POLICY, "call_mcp_tool", { ServerName: "other", ToolName: "kb_search" }).decision).toBe("deny");
  });

  it.each([
    ["missing both", {}],
    ["missing ToolName", { ServerName: "company" }],
    ["missing ServerName", { ToolName: "kb_search" }],
    ["non-string ServerName", { ServerName: 42, ToolName: "kb_search" }],
    ["non-string ToolName", { ServerName: "company", ToolName: null }],
    ["empty-string ServerName", { ServerName: "", ToolName: "kb_search" }],
  ])("denies call_mcp_tool with malformed params: %s", (_label, parameters) => {
    const decision = evaluatePolicy(POLICY, "call_mcp_tool", parameters as Record<string, unknown>);
    expect(decision.decision).toBe("deny");
  });

  it("does NOT accept a namespaced ServerName as a match for the unnamespaced policy entry (exact match only)", () => {
    // agy namespaces MCP servers loaded from local plugins as `<plugin>_<server>`
    // (docs/PHASE0.md spike 02); the company server is wired directly (not as a
    // plugin), so ServerName should always be exactly "company". Accepting a
    // namespaced suffix match here would let an unrelated plugin server ride on
    // this agent's company MCP policy — fail closed instead.
    const decision = evaluatePolicy(POLICY, "call_mcp_tool", { ServerName: "someplugin_company", ToolName: "kb_search" });
    expect(decision.decision).toBe("deny");
  });
});

describe("evaluatePolicy — agy control tools", () => {
  it("always allows finish, even with an empty policy (needed to return --json-schema results)", () => {
    expect(evaluatePolicy({ builtins: [], mcp: [] }, "finish", { status: "done" })).toEqual({ decision: "allow" });
  });
});

describe("evaluatePolicy — path confinement", () => {
  const roots = ["/data/workspaces/sdr-01", "/home/u/.gemini/antigravity-cli/brain/conv-1"];

  it("allows absolute paths inside an allowed root", () => {
    const d = evaluatePolicy(POLICY, "view_file", { AbsolutePath: "/data/workspaces/sdr-01/AGENTS.md" }, { allowedRoots: roots });
    expect(d).toEqual({ decision: "allow" });
    const brain = evaluatePolicy(POLICY, "view_file", { AbsolutePath: "/home/u/.gemini/antigravity-cli/brain/conv-1/steps/5/content.md" }, { allowedRoots: roots });
    expect(brain).toEqual({ decision: "allow" });
  });

  it("denies paths outside the roots, including .. escapes, ~ and sibling-prefix tricks", () => {
    for (const p of [
      "/Users/me/agy-ui/packages/hooks/dist/stop.mjs",
      "/data/workspaces/sdr-01/../sdr-02/AGENTS.md",
      "/data/workspaces/sdr-01-evil/x",
      "~/.gemini/config/config.json",
      "file:///etc/passwd",
    ]) {
      const d = evaluatePolicy(POLICY, "view_file", { AbsolutePath: p }, { allowedRoots: roots });
      expect(d.decision, p).toBe("deny");
    }
    expect(evaluatePolicy(POLICY, "list_dir", { DirectoryPath: "/etc" }, { allowedRoots: roots }).decision).toBe("deny");
  });

  it("allows relative paths and non-path params, and skips the check when no roots are given", () => {
    expect(evaluatePolicy(POLICY, "view_file", { AbsolutePath: "kb/icp.md" }, { allowedRoots: roots })).toEqual({ decision: "allow" });
    expect(evaluatePolicy(POLICY, "view_file", { AbsolutePath: "/etc/passwd" })).toEqual({ decision: "allow" });
  });
});
