// Agent registry provisioning: create an Agent row + render its workspace
// from a role template, and re-render (template or vars changed) without
// losing agent-instance data.

import path from "node:path";
import type { Agent, AgentRole, TrustTier } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { loadTemplate, renderWorkspace, type RenderVars } from "@agyhq/workspace";
import type { AgyhqConfig } from "./config.ts";
import { isValidSlug, ValidationError } from "./util.ts";

export interface ProvisionCtx {
  config: AgyhqConfig;
  db: Db;
}

export interface CreateAgentArgs {
  id: string;
  role: AgentRole;
  displayName: string;
  model?: string;
  trustTier?: TrustTier;
  maxConcurrency?: number;
}

export function buildRenderVars(config: AgyhqConfig, extra: Partial<RenderVars> = {}): RenderVars {
  return {
    apiUrl: `http://${config.host}:${config.port}`,
    hooksDistDir: config.hooksDistDir,
    mcpEntry: config.mcpEntry,
    nodeBin: config.nodeBin,
    companyName: config.companyName,
    ...extra,
  };
}

/** Create a new agent: validates the id, loads the role template, inserts the registry row, renders the workspace. */
export function createAgent(ctx: ProvisionCtx, args: CreateAgentArgs): Agent {
  if (!isValidSlug(args.id)) {
    throw new ValidationError(
      `invalid agent id "${args.id}": must be lowercase alphanumeric with internal hyphens (e.g. "sdr-01")`,
    );
  }
  if (ctx.db.agents.get(args.id)) {
    throw new ValidationError(`agent "${args.id}" already exists`);
  }

  const template = loadTemplate(ctx.config.templatesRoot, args.role);
  const workspacePath = path.join(ctx.config.workspacesRoot, args.id);

  const agent = ctx.db.agents.create({
    id: args.id,
    role: args.role,
    displayName: args.displayName,
    model: args.model ?? template.defaultModel,
    workspacePath,
    policy: template.policy,
    trustTier: args.trustTier,
    maxConcurrency: args.maxConcurrency,
  });

  renderWorkspace({
    agent,
    template,
    templatesRoot: ctx.config.templatesRoot,
    outDir: workspacePath,
    vars: buildRenderVars(ctx.config, { displayName: agent.displayName }),
  });

  return agent;
}

/** Re-render one agent's workspace from its (possibly updated) role template. */
export function rerender(ctx: ProvisionCtx, agentId: string): { agent: Agent; files: string[] } {
  const agent = ctx.db.agents.get(agentId);
  if (!agent) throw new ValidationError(`agent "${agentId}" not found`);

  const template = loadTemplate(ctx.config.templatesRoot, agent.role);
  const { files } = renderWorkspace({
    agent,
    template,
    templatesRoot: ctx.config.templatesRoot,
    outDir: agent.workspacePath,
    vars: buildRenderVars(ctx.config, { displayName: agent.displayName }),
  });
  return { agent, files };
}

/** Re-render every registered agent's workspace (templates may have changed since they were provisioned). */
export function rerenderAll(ctx: ProvisionCtx): { agentId: string; ok: boolean; error?: string }[] {
  const results: { agentId: string; ok: boolean; error?: string }[] = [];
  for (const agent of ctx.db.agents.list()) {
    try {
      rerender(ctx, agent.id);
      results.push({ agentId: agent.id, ok: true });
    } catch (err) {
      results.push({ agentId: agent.id, ok: false, error: (err as Error).message });
    }
  }
  return results;
}
