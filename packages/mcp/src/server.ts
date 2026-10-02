// The company MCP server: registers exactly the tools in @agyhq/core's
// McpTools, validates args with the core zod schemas, and proxies each call
// to the agy-hq daemon via HqClient. Never throws out of a tool handler —
// agy spawns this process per task, and a crash would hang/break the run.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpTools } from "@agyhq/core";
import type { McpToolName } from "@agyhq/core";
import type { HqClient, HqClientEnvError } from "./hq-client.ts";

export interface CreateCompanyMcpServerOptions {
  /**
   * The HQ client to proxy tool calls through, or null when required
   * AGYHQ_* env vars were missing. When null, every tool call returns an
   * explanatory isError result instead of attempting a request (see
   * HqClient.fromEnv).
   */
  client: HqClient | null;
  /** Present when client is null; used to compose the misconfiguration message. */
  envError?: HqClientEnvError;
}

const SERVER_NAME = "company-mcp";
const SERVER_VERSION = "0.1.0";

export function createCompanyMcpServer(options: CreateCompanyMcpServerOptions): McpServer {
  const { client } = options;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const misconfiguredMessage = client
    ? null
    : `company MCP server is not configured: missing env var(s) ${(options.envError?.missing ?? []).join(", ") || "AGYHQ_API_URL, AGYHQ_TOKEN, AGYHQ_AGENT_ID"}. ` +
      "This agent's workspace must set these before agy starts; the tool cannot reach agy-hq.";

  for (const toolName of Object.keys(McpTools) as McpToolName[]) {
    const tool = McpTools[toolName];
    const inputShape = toRawShape(tool.input);

    server.registerTool(
      toolName,
      {
        description: tool.description,
        inputSchema: inputShape,
      },
      async (rawArgs: unknown): Promise<CallToolResult> => {
        try {
          if (!client) {
            return errorResult(misconfiguredMessage!);
          }

          // MCP only validated the raw shape; run the FULL core schema here
          // (this is where crm_find_contact's .refine cross-field rule, and
          // any other whole-object validation, actually gets enforced).
          const parsed = tool.input.safeParse(rawArgs);
          if (!parsed.success) {
            return errorResult(`invalid arguments for ${toolName}: ${formatZodError(parsed.error)}`);
          }

          const envelope = await client.callTool(toolName, parsed.data);
          if (!envelope.ok) {
            return errorResult(`${toolName} failed (${envelope.error.code}): ${envelope.error.message}`);
          }

          return {
            content: [{ type: "text", text: JSON.stringify(envelope.data, null, 2) }],
          };
        } catch (err) {
          // Defense in depth: a handler bug must never crash the process.
          return errorResult(
            `unexpected error running ${toolName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    );
  }

  return server;
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
}

/**
 * MCP's registerTool wants a zod "raw shape" (plain object of field ->
 * schema), but crm_find_contact's core schema is `z.object({...}).refine(...)`
 * (a ZodEffects wrapping a ZodObject). Unwrap any ZodEffects layers to get at
 * the underlying object's shape for the tool's advertised inputSchema; the
 * full schema (effects included) is still run per-call in the handler above,
 * so the .refine rule is enforced even though MCP's own validation only sees
 * the plain shape.
 */
function toRawShape(schema: z.ZodTypeAny): z.ZodRawShape {
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodEffects) {
    current = current.innerType();
  }
  if (current instanceof z.ZodObject) {
    return current.shape as z.ZodRawShape;
  }
  throw new Error("McpTools input schema must be a z.object() (optionally wrapped in .refine/.transform)");
}
