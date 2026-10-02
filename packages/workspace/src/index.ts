export type {
  Template,
  TemplateJson,
  TaskKindSpec,
  RenderVars,
  RenderWorkspaceArgs,
  RenderWorkspaceResult,
} from "./types.ts";
export { TemplateJsonZ, TaskKindSpecZ, ToolPolicyZ, McpToolRefZ } from "./types.ts";

export { loadTemplate, listTemplateRoles } from "./template-loader.ts";
export { renderWorkspace, renderPrompt } from "./render.ts";

export { buildHooksConfig, HOOKS_BUNDLE_NAME } from "./hooks-config.ts";
export type { HooksConfig, HooksConfigVars } from "./hooks-config.ts";

export { buildMcpConfig } from "./mcp-config.ts";
export type { McpConfig, McpConfigVars } from "./mcp-config.ts";

export { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
export type { FrontmatterData, FrontmatterValue, ParsedFrontmatter } from "./frontmatter.ts";

export { renderPlaceholders, flattenForPlaceholders } from "./placeholders.ts";
