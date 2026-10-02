// Template & render types for @agyhq/workspace.
// See docs/PHASE0.md D6 and docs/PLAN.md section 3.1 for the design this implements.

import { z } from "zod";
import type { Agent, ToolPolicy } from "@agyhq/core";

// ---------------------------------------------------------------------------
// template.json shape (validated with zod)

export const McpToolRefZ = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
});

export const ToolPolicyZ = z.object({
  builtins: z.array(z.string()),
  mcp: z.array(McpToolRefZ),
});

export const TaskKindSpecZ = z.object({
  kind: z.string().min(1),
  description: z.string().min(1),
  /** Path to a prompt .md file, relative to the template directory. */
  prompt: z.string().min(1),
});
export type TaskKindSpec = z.infer<typeof TaskKindSpecZ>;

export const TemplateJsonZ = z.object({
  role: z.string().min(1),
  description: z.string().min(1),
  /** agy model id, e.g. "gemini-3.8-flash-medium". */
  defaultModel: z.string().min(1),
  policy: ToolPolicyZ,
  /** Path to a JSON Schema file, relative to the template directory. */
  resultSchema: z.string().min(1),
  taskKinds: z.array(TaskKindSpecZ).min(1),
});
export type TemplateJson = z.infer<typeof TemplateJsonZ>;

/** A loaded, validated role template, ready to render into a workspace. */
export interface Template {
  role: string;
  description: string;
  defaultModel: string;
  policy: ToolPolicy;
  taskKinds: TaskKindSpec[];
  /** Absolute path to templates/<role>/. */
  templateDir: string;
  /** Absolute path to the result-schema.json file. */
  resultSchemaPath: string;
  /** Parsed JSON Schema (TaskResult-shaped), for the runner to pass to `agy --json-schema`. */
  resultSchema: unknown;
  hasRules: boolean;
  hasSkills: boolean;
  hasKb: boolean;
}

// ---------------------------------------------------------------------------
// renderWorkspace / renderPrompt

/** Variables available to `{{placeholder}}` substitution in template files. */
export interface RenderVars {
  /** Base URL of the agy-hq control-plane API (AGYHQ_API_URL). Informational; not embedded in rendered files unless a template placeholder references it. */
  apiUrl: string;
  /** Absolute path to the built @agyhq/hooks scripts (dist dir), used to build hooks.json commands. */
  hooksDistDir: string;
  /** Absolute path to the built @agyhq/mcp server entrypoint, used to build mcp_config.json. */
  mcpEntry: string;
  /** Absolute path to the node binary to invoke hooks/MCP with. */
  nodeBin: string;
  /** Display name of the company the agent works for, for persona/kb placeholders. */
  companyName: string;
  /** Additional template-specific placeholder values. */
  [key: string]: string | undefined;
}

export interface RenderWorkspaceArgs {
  agent: Agent;
  template: Template;
  templatesRoot: string;
  outDir: string;
  vars: RenderVars;
}

export interface RenderWorkspaceResult {
  /** Every file written or kept by this render, relative to outDir, sorted. */
  files: string[];
}
