#!/usr/bin/env node
// stdio entrypoint for the company MCP server. This is what a workspace's
// .agents/mcp_config.json points `command`/`args` at (server key "company").
//
// IMPORTANT: stdout is the MCP protocol channel (JSON-RPC over stdio) — never
// write anything else to it. All diagnostics go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCompanyMcpServer } from "../server.ts";
import { HqClient } from "../hq-client.ts";

async function main(): Promise<void> {
  const result = HqClient.fromEnv();

  if (result.client) {
    console.error("[company-mcp] configured; proxying tool calls to agy-hq daemon");
  } else {
    console.error(
      `[company-mcp] WARNING: missing env var(s) ${result.error.missing.join(", ")}. ` +
        "The server will still start, but every tool call will return an error."
    );
  }

  const server = createCompanyMcpServer(result.client ? { client: result.client } : { client: null, envError: result.error });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[company-mcp] connected over stdio");
}

main().catch((err) => {
  console.error("[company-mcp] fatal error during startup:", err);
  process.exit(1);
});
