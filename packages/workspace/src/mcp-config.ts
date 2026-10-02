// Builds .agents/mcp_config.json. The server key MUST be exactly
// COMPANY_MCP_SERVER ("company") — agy reports it back as `ServerName` in
// `call_mcp_tool` parameters, and the PreToolUse policy hook / company MCP
// server both key off that name (see packages/core/src/api.ts).
//
// Env verification (required by the task brief): built a stub stdio MCP
// server (packages/workspace/test/fixtures/stub-mcp/server.mjs) that echoes
// back AGYHQ_* from `process.env`, registered it in a throwaway rendered
// workspace, and ran real `agy` (v1.2.14) with AGYHQ_API_URL/AGYHQ_TOKEN/
// AGYHQ_AGENT_ID/AGYHQ_TASK_ID set on the `agy` process itself. The
// `call_mcp_tool` result contained the exact values verbatim — CONFIRMED a
// stdio MCP server child process DOES inherit agy's environment, the same
// way spike 03 found hooks do. So no `env` block is needed here: the runner
// setting AGYHQ_* on the `agy` process is sufficient for the company MCP
// server to see them too. (If this ever turns out NOT to hold for a future
// agy version, add an `env` map here with the same AGYHQ_* vars and chmod
// the rendered file 600, per the task brief's fallback instruction.)

import { COMPANY_MCP_SERVER } from "@agyhq/core";

export interface McpConfigVars {
  /** Absolute path to the node binary to run the company MCP server with. */
  nodeBin: string;
  /** Absolute path to the built @agyhq/mcp server entrypoint. */
  mcpEntry: string;
}

export interface McpConfig {
  mcpServers: {
    [server: string]: { command: string; args: string[] };
  };
}

export function buildMcpConfig({ nodeBin, mcpEntry }: McpConfigVars): McpConfig {
  return {
    mcpServers: {
      [COMPANY_MCP_SERVER]: {
        command: nodeBin,
        args: [mcpEntry],
      },
    },
  };
}
