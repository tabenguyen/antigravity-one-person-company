// End-to-end interop proof: the BUILT @agyhq/hooks and @agyhq/mcp artifacts
// (the exact dependency-free files a real `agy` workspace invokes) talking to
// THIS router, served over real HTTP via @hono/node-server on a random local
// port. If this passes, the three packages' wire contracts actually line up.
//
// Skips (rather than fails) if the dist/ artifacts haven't been built yet —
// mirrors the pattern in packages/mcp/test/stdio.test.ts.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpTools } from "@agyhq/core";
import type { McpToolName } from "@agyhq/core";
import { setupTestApi } from "./test-helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIST = path.resolve(here, "../../../hooks/dist");
const MCP_DIST_ENTRY = path.resolve(here, "../../../mcp/dist/company-mcp.mjs");
const PRE_TOOL_USE_ENTRY = path.join(HOOKS_DIST, "pre-tool-use.mjs");

const built = existsSync(PRE_TOOL_USE_ENTRY) && existsSync(MCP_DIST_ENTRY);
const describeIfBuilt = built ? describe : describe.skip;

interface HookSpawnResult {
  exitCode: number | null;
  json: unknown;
}

function runPreToolUseHook(env: Record<string, string>, stdin: string): Promise<HookSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRE_TOOL_USE_ENTRY], {
      env: { ...env, PATH: process.env["PATH"] ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      let json: unknown = null;
      try {
        json = stdout.trim().length > 0 ? JSON.parse(stdout) : null;
      } catch {
        json = null;
      }
      resolve({ exitCode, json });
    });
    child.stdin.end(stdin);
  });
}

describeIfBuilt("contract: built @agyhq/hooks + @agyhq/mcp against this router over real HTTP", () => {
  let api: ReturnType<typeof setupTestApi>;
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    api = setupTestApi();
    await new Promise<void>((resolve) => {
      server = serve({ fetch: api.app.fetch, port: 0 }, (info: AddressInfo) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    api.db.close();
  });

  it("pre-tool-use.mjs: the daemon's allow for a policy-listed builtin reaches the real hook binary's stdout", async () => {
    const env = {
      AGYHQ_API_URL: baseUrl,
      AGYHQ_TOKEN: api.token,
      AGYHQ_AGENT_ID: api.agentId,
      AGYHQ_TASK_ID: api.taskId,
    };
    const payload = JSON.stringify({
      conversationId: "conv-contract-1",
      workspacePaths: ["/tmp/ws"],
      transcriptPath: "/tmp/transcript.jsonl",
      artifactDirectoryPath: "/tmp/artifacts",
      modelName: "gemini-3.8-flash-medium",
      stepIdx: 0,
      toolCall: { name: "view_file", args: { path: "AGENTS.md" } },
    });
    const result = await runPreToolUseHook(env, payload);
    expect(result.json).toEqual({ decision: "allow" });

    const rows = api.db.audit.list({ agentId: api.agentId, taskId: api.taskId, kind: ["tool.pre"] });
    expect(rows.some((r) => r.data["toolName"] === "view_file")).toBe(true);
  });

  it("pre-tool-use.mjs: the daemon's deny for a policy-excluded tool reaches the real hook binary's stdout, with the reason intact", async () => {
    const env = {
      AGYHQ_API_URL: baseUrl,
      AGYHQ_TOKEN: api.token,
      AGYHQ_AGENT_ID: api.agentId,
      AGYHQ_TASK_ID: api.taskId,
    };
    const payload = JSON.stringify({
      conversationId: "conv-contract-2",
      workspacePaths: ["/tmp/ws"],
      transcriptPath: "/tmp/transcript.jsonl",
      artifactDirectoryPath: "/tmp/artifacts",
      modelName: "gemini-3.8-flash-medium",
      stepIdx: 1,
      toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } },
    });
    const result = await runPreToolUseHook(env, payload);
    const json = result.json as { decision: string; reason: string };
    expect(json.decision).toBe("deny");
    expect(json.reason).toContain("run_command");

    const rows = api.db.audit.list({ agentId: api.agentId, taskId: api.taskId, kind: ["tool.denied"] });
    expect(rows.some((r) => r.data["toolName"] === "run_command")).toBe(true);
  });

  it("company-mcp.mjs: lists exactly core McpTools and proxies a real kb_search call through to this db", async () => {
    api.db.kb.upsertDocument({
      scope: "company",
      title: "Contract Test Doc",
      sourcePath: "contract.md",
      body: "# Contract Test Doc\nA very specific needle: xylophone-42.",
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_DIST_ENTRY],
      env: {
        ...getDefaultEnvironment(),
        AGYHQ_API_URL: baseUrl,
        AGYHQ_TOKEN: api.token,
        AGYHQ_AGENT_ID: api.agentId,
        AGYHQ_TASK_ID: api.taskId,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "contract-test-client", version: "0.0.0" });
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual((Object.keys(McpTools) as McpToolName[]).sort());

      const result = await client.callTool({ name: "kb_search", arguments: { query: "xylophone-42" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as { results: Array<{ title: string }> };
      expect(parsed.results.some((r) => r.title === "Contract Test Doc")).toBe(true);

      const auditRows = api.db.audit.list({ agentId: api.agentId, taskId: api.taskId, kind: ["kb.search"] });
      expect(auditRows.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("company-mcp.mjs: a validation error from the core schema surfaces as isError, never reaching the daemon as a crash", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_DIST_ENTRY],
      env: {
        ...getDefaultEnvironment(),
        AGYHQ_API_URL: baseUrl,
        AGYHQ_TOKEN: api.token,
        AGYHQ_AGENT_ID: api.agentId,
        AGYHQ_TASK_ID: api.taskId,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "contract-test-client-2", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "crm_find_contact", arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
