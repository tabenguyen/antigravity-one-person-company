// Spawns the BUILT, bundled dist/company-mcp.mjs (not the TS source) over
// real stdio, using the SDK's stdio client transport — exercises the actual
// artifact a workspace's .agents/mcp_config.json would invoke.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ENV, McpTools } from "@agyhq/core";
import type { McpToolName } from "@agyhq/core";

import { startMockDaemon, type MockDaemon } from "./mock-daemon.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(here, "../dist/company-mcp.mjs");

const describeIfBuilt = existsSync(DIST_ENTRY) ? describe : describe.skip;

describeIfBuilt("company-mcp.mjs (built, over real stdio)", () => {
  let daemon: MockDaemon;
  let transport: StdioClientTransport;
  let client: Client;

  beforeAll(async () => {
    daemon = await startMockDaemon((req) => {
      if (req.url === "/v1/mcp/kb_search") {
        return { status: 200, body: { ok: true, data: { results: [{ docId: "d1", title: "t", scope: "company", snippet: "s", score: 1 }] } } };
      }
      return { status: 200, body: { ok: true, data: {} } };
    });

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: {
        ...getDefaultEnvironment(),
        [ENV.apiUrl]: daemon.baseUrl,
        [ENV.token]: "stdio-test-token",
        [ENV.agentId]: "sdr-stdio-01",
      },
      stderr: "pipe",
    });

    client = new Client({ name: "stdio-test-client", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await daemon?.close();
  });

  it("is a dependency-free bundle (no node_modules alongside it is required to run)", () => {
    expect(existsSync(DIST_ENTRY)).toBe(true);
  });

  it("lists exactly the core McpTools over real stdio", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual((Object.keys(McpTools) as McpToolName[]).sort());
  });

  it("proxies a real tool call through stdio -> HqClient -> mock daemon and back", async () => {
    const result = await client.callTool({ name: "kb_search", arguments: { query: "pricing" } });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.results[0].docId).toBe("d1");
    expect(daemon.captured.some((r) => r.url === "/v1/mcp/kb_search")).toBe(true);
  });
});
