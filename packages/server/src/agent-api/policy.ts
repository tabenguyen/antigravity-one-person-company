// Pure policy engine for the PreToolUse hook. No I/O — unit-tested directly.
//
// Design decisions (documented per the task brief):
// - Default deny. Only tools explicitly listed are allowed.
// - `call_mcp_tool` is special-cased: the real tool identity lives in
//   `parameters.ServerName`/`parameters.ToolName`, not in `toolName` itself.
// - ServerName matching is EXACT, not prefix/namespace-aware. agy namespaces
//   MCP servers loaded from local *plugins* as `<plugin>_<server>` (see
//   docs/PHASE0.md spike 02), but the company MCP server is wired via each
//   workspace's top-level `.agents/mcp_config.json` under the literal key
//   "company" (`COMPANY_MCP_SERVER`), never as a plugin — so on the wire
//   ServerName should always be exactly "company". Accepting a namespaced
//   match (e.g. suffix-matching `*_company`) would let a malicious/local
//   plugin that happens to register a server named "company" ride on this
//   agent's MCP policy. Fail-closed wins: exact match only. If a future
//   template legitimately ships the company MCP server as a local plugin,
//   the policy (`ToolPolicy.mcp[].server`) should list the full namespaced
//   name explicitly rather than this function guessing at a transform.
// - Reasons are short and tell the model what it may do instead, since
//   `@agyhq/hooks` feeds `reason` back to the model verbatim on deny.

// - agy's own control tools (ALWAYS_ALLOWED_BUILTINS) are allowed regardless of
//   policy: with --json-schema, `finish` is the only way a run can return its
//   structured result. Denying it makes agy re-prompt until MAX_FORCED_INVOCATIONS.
// - Filesystem built-ins are confined to `allowedRoots` when given: any absolute
//   path parameter outside them is denied (agents otherwise wander into
//   ~/.gemini or the harness's own source).

import path from "node:path";
import type { PolicyDecision, ToolPolicy } from "@agyhq/core";

export const ALWAYS_ALLOWED_BUILTINS: readonly string[] = ["finish"];

export interface PolicyContext {
  /** Absolute directories file-reading built-ins may touch. Omit to skip the path check. */
  allowedRoots?: string[];
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(none)";
}

const PATH_PARAM = /(path|directory|dir|file)$/i;

/** Absolute path-like string parameters of a built-in tool call (e.g. view_file AbsolutePath). */
export function absolutePathParams(parameters: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== "string" || !PATH_PARAM.test(key)) continue;
    const v = value.startsWith("file://") ? value.slice("file://".length) : value;
    if (path.isAbsolute(v) || v.startsWith("~")) out.push(v);
  }
  return out;
}

function isInside(target: string, roots: string[]): boolean {
  if (target.startsWith("~")) return false;
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export function evaluatePolicy(
  policy: ToolPolicy,
  toolName: string,
  parameters: Record<string, unknown>,
  context: PolicyContext = {},
): PolicyDecision {
  if (ALWAYS_ALLOWED_BUILTINS.includes(toolName)) {
    return { decision: "allow" };
  }

  if (toolName === "call_mcp_tool") {
    const serverName = parameters["ServerName"];
    const mcpToolName = parameters["ToolName"];

    if (typeof serverName !== "string" || serverName.length === 0 || typeof mcpToolName !== "string" || mcpToolName.length === 0) {
      return {
        decision: "deny",
        reason:
          'call_mcp_tool requires string "ServerName" and "ToolName" parameters; this call is missing or malformed. ' +
          "Retry with both fields set to the exact server/tool you intend to call.",
      };
    }

    const allowed = policy.mcp.some((ref) => ref.server === serverName && (ref.tool === "*" || ref.tool === mcpToolName));
    if (!allowed) {
      const allowedList = policy.mcp.map((ref) => `${ref.server}/${ref.tool}`);
      return {
        decision: "deny",
        reason: `MCP tool "${serverName}/${mcpToolName}" is not allowed for this agent. Allowed MCP tools: ${listOrNone(allowedList)}.`,
      };
    }

    return { decision: "allow" };
  }

  if (policy.builtins.includes(toolName)) {
    if (context.allowedRoots) {
      const outside = absolutePathParams(parameters).filter((p) => !isInside(p, context.allowedRoots!));
      if (outside.length > 0) {
        return {
          decision: "deny",
          reason: `Path "${outside[0]}" is outside your workspace. File tools may only read inside your workspace; use kb_search and the CRM tools for company knowledge.`,
        };
      }
    }
    return { decision: "allow" };
  }

  return {
    decision: "deny",
    reason: `Tool "${toolName}" is not allowed for this agent. Allowed built-ins: ${listOrNone(policy.builtins)}. Use one of those, or call_mcp_tool with an allowed company tool.`,
  };
}
