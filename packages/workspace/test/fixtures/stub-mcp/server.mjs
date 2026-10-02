import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "company", version: "0.0.1" });

server.registerTool(
  "env_dump",
  {
    title: "Env dump",
    description:
      "Returns the AGYHQ_* environment variables visible to this MCP server process. Call this tool with no arguments whenever asked.",
    inputSchema: {},
  },
  async () => {
    const out = {
      AGYHQ_API_URL: process.env.AGYHQ_API_URL ?? null,
      AGYHQ_TOKEN: process.env.AGYHQ_TOKEN ?? null,
      AGYHQ_AGENT_ID: process.env.AGYHQ_AGENT_ID ?? null,
      AGYHQ_TASK_ID: process.env.AGYHQ_TASK_ID ?? null,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
