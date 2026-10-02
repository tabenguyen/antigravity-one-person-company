import type { Agent, ToolPolicy } from "@agyhq/core";
import type { RenderVars } from "../src/index.ts";

export function makeAgent(overrides: Partial<Agent> & { policy: ToolPolicy }): Agent {
  const now = new Date().toISOString();
  return {
    id: "sdr-01",
    role: "sales-sdr",
    displayName: "Mai",
    model: "gemini-3.8-flash-medium",
    status: "active",
    trustTier: "shadow",
    workspacePath: "",
    managerId: null,
    maxConcurrency: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeVars(overrides: Partial<RenderVars> = {}): RenderVars {
  return {
    apiUrl: "http://127.0.0.1:7317",
    hooksDistDir: "/abs/hooks/dist",
    mcpEntry: "/abs/mcp/dist/company-mcp.mjs",
    nodeBin: "/usr/bin/node",
    companyName: "Makini",
    ...overrides,
  };
}
