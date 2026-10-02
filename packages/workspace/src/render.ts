// renderWorkspace: templates/<role>/ -> workspaces/<agent-id>/
// renderPrompt: templates/<role>/prompts/<kind>.md -> rendered task prompt string
//
// Re-render is idempotent: running it again with the same template/vars
// produces the same files, and files that are no longer part of the
// template get removed — but ONLY inside outDir/.agents/ and outDir/AGENTS.md.
// Nothing else in outDir (e.g. a future outDir/.agyhq/ runtime-state dir) is
// ever touched, read, or deleted by this module.

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter, type FrontmatterData } from "./frontmatter.ts";
import { renderPlaceholders, flattenForPlaceholders } from "./placeholders.ts";
import { buildHooksConfig } from "./hooks-config.ts";
import { buildMcpConfig } from "./mcp-config.ts";
import type { RenderWorkspaceArgs, RenderWorkspaceResult, Template } from "./types.ts";

const AGENTS_DIR = ".agents";
/** Sibling of the role directories under templatesRoot; not a role (no template.json). */
const SHARED_DIR = "_shared";

function buildPlaceholderCtx(args: RenderWorkspaceArgs): Record<string, string> {
  const { agent, vars } = args;
  const ctx: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) ctx[k] = v;
  }
  // Agent-derived values always win: they are canonical, not user-suppliable "vars".
  ctx.agentId = agent.id;
  ctx.role = agent.role;
  ctx.displayName = agent.displayName;
  ctx.model = agent.model;
  return ctx;
}

function readFile(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function renderAgentsMd(template: Template, ctx: Record<string, string>): string {
  const raw = readFile(path.join(template.templateDir, "AGENTS.md"));
  return renderPlaceholders(raw, ctx, "AGENTS.md");
}

function renderAgentMd(template: Template, ctx: Record<string, string>, builtins: string[], model: string): string {
  const srcPath = path.join(template.templateDir, "agent.md");
  const raw = readFile(srcPath);
  const { data, body } = parseFrontmatter(raw, "agent.md");
  const descriptionRaw = data.description;
  if (typeof descriptionRaw !== "string" || descriptionRaw.length === 0) {
    throw new Error(`agent.md for role "${template.role}" must have a non-empty "description" in its frontmatter`);
  }
  const description = renderPlaceholders(descriptionRaw, ctx, "agent.md#description");
  const renderedBody = renderPlaceholders(body, ctx, "agent.md body");

  // Per the workspace contract: name/tools/model always come from the agent
  // instance, never from the template's own frontmatter (which is only a
  // human-authoring convenience / default-persona preview).
  const frontmatter: FrontmatterData = {
    name: template.role,
    description,
    // `finish` must be listed explicitly: with a `tools:` allowlist agy does not add it on its own,
    // and without it a --json-schema run can't return its structured result ("unknown tool: finish").
    tools: [...new Set([...builtins, "finish"])],
    model,
  };
  return stringifyFrontmatter(frontmatter, renderedBody);
}

function renderRuleOrSkill(srcPath: string, sourceLabel: string, ctx: Record<string, string>): string {
  const raw = readFile(srcPath);
  const { data, body } = parseFrontmatter(raw, sourceLabel);
  const renderedData: FrontmatterData = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      renderedData[key] = value.map((v) => renderPlaceholders(v, ctx, `${sourceLabel}#${key}`));
    } else {
      renderedData[key] = renderPlaceholders(value, ctx, `${sourceLabel}#${key}`);
    }
  }
  const renderedBody = renderPlaceholders(body, ctx, `${sourceLabel} body`);
  return stringifyFrontmatter(renderedData, renderedBody);
}

function listMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

function listSkillDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

function writeFileEnsured(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
}

/** Recursively list files under dir, as paths relative to `relTo`. */
function walkFiles(dir: string, relTo: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, relTo));
    } else if (entry.isFile()) {
      out.push(path.relative(relTo, abs));
    }
  }
  return out;
}

/** Remove empty directories under dir (bottom-up), but never dir itself if it's the .agents root and must stay. */
function pruneEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

export function renderWorkspace(args: RenderWorkspaceArgs): RenderWorkspaceResult {
  const { agent, template, outDir, vars } = args;
  if (agent.role !== template.role) {
    throw new Error(`Agent role "${agent.role}" does not match template role "${template.role}"`);
  }

  const ctx = buildPlaceholderCtx(args);
  const desired = new Map<string, string>(); // relative path (posix-ish, using path.join semantics) -> content

  desired.set("AGENTS.md", renderAgentsMd(template, ctx));
  desired.set(
    path.join(AGENTS_DIR, "agents", `${template.role}.md`),
    renderAgentMd(template, ctx, agent.policy.builtins, agent.model),
  );

  // Rules every role gets (templates/_shared/rules/); a role's own rule with the same file name wins.
  const sharedRulesDir = path.join(path.dirname(template.templateDir), SHARED_DIR, "rules");
  for (const file of listMdFiles(sharedRulesDir)) {
    const rendered = renderRuleOrSkill(path.join(sharedRulesDir, file), `${SHARED_DIR}/rules/${file}`, ctx);
    desired.set(path.join(AGENTS_DIR, "rules", file), rendered);
  }

  if (template.hasRules) {
    const rulesDir = path.join(template.templateDir, "rules");
    for (const file of listMdFiles(rulesDir)) {
      const rendered = renderRuleOrSkill(path.join(rulesDir, file), `rules/${file}`, ctx);
      desired.set(path.join(AGENTS_DIR, "rules", file), rendered);
    }
  }

  if (template.hasSkills) {
    const skillsDir = path.join(template.templateDir, "skills");
    for (const name of listSkillDirs(skillsDir)) {
      const rendered = renderRuleOrSkill(path.join(skillsDir, name, "SKILL.md"), `skills/${name}/SKILL.md`, ctx);
      desired.set(path.join(AGENTS_DIR, "skills", name, "SKILL.md"), rendered);
    }
  }

  desired.set(
    path.join(AGENTS_DIR, "hooks.json"),
    `${JSON.stringify(buildHooksConfig({ nodeBin: vars.nodeBin, hooksDistDir: vars.hooksDistDir }), null, 2)}\n`,
  );
  desired.set(
    path.join(AGENTS_DIR, "mcp_config.json"),
    `${JSON.stringify(buildMcpConfig({ nodeBin: vars.nodeBin, mcpEntry: vars.mcpEntry }), null, 2)}\n`,
  );

  // Remove anything previously rendered under AGENTS.md/.agents/ that's no
  // longer desired (idempotent re-render). Never touch anything else in outDir.
  const existing = new Set<string>(walkFiles(path.join(outDir, AGENTS_DIR), outDir));
  if (fs.existsSync(path.join(outDir, "AGENTS.md"))) existing.add("AGENTS.md");
  for (const relPath of existing) {
    if (!desired.has(relPath)) {
      fs.rmSync(path.join(outDir, relPath), { force: true });
    }
  }
  pruneEmptyDirs(path.join(outDir, AGENTS_DIR));

  for (const [relPath, content] of desired) {
    writeFileEnsured(path.join(outDir, relPath), content);
  }

  return { files: Array.from(desired.keys()).sort() };
}

export function renderPrompt(template: Template, kind: string, input: Record<string, unknown>): string {
  const spec = template.taskKinds.find((tk) => tk.kind === kind);
  if (!spec) {
    throw new Error(
      `Unknown task kind "${kind}" for role "${template.role}". Known kinds: ${template.taskKinds.map((t) => t.kind).join(", ")}`,
    );
  }
  const promptPath = path.join(template.templateDir, spec.prompt);
  const raw = readFile(promptPath);
  // Task input comes from humans, other agents and follow-up scheduling, so it is often
  // partial: missing fields render as "(not provided)" instead of failing the task, and
  // the full input is appended so fields the template doesn't mention stay visible.
  const ctx = flattenForPlaceholders(input);
  const rendered = raw.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) => ctx[key] ?? "(not provided)");
  if (Object.keys(input).length === 0) return rendered;
  return `${rendered.trimEnd()}\n\n## Task input (raw)\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n`;
}
