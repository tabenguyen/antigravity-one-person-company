// Knowledge-base ingestion: walks three layers of plain Markdown into
// @agyhq/db's KB (company-wide, per-role, per-agent), substituting
// {{companyName}} (the one placeholder these files are allowed to carry —
// see templates/workspace README: kb/*.md is NOT rendered by @agyhq/workspace,
// it's ingested here instead), and removes documents whose source file
// disappeared since the last sync.

import fs from "node:fs";
import path from "node:path";
import type { AgentRole, KbScope } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { listTemplateRoles } from "@agyhq/workspace";
import type { AgyhqConfig } from "./config.ts";

export interface KbIngestCtx {
  config: AgyhqConfig;
  db: Db;
}

export interface KbSyncResult {
  scope: KbScope;
  sourcePath: string;
  changed: boolean;
}

export interface KbSyncSummary {
  scanned: number;
  changed: number;
  deleted: number;
  results: KbSyncResult[];
}

/** Subdirectory of kbRoot holding per-role overrides: kbRoot/roles/<role>/*.md (never company-scope documents). */
export const ROLE_OVERRIDE_SUBDIR = "roles";
const KNOWN_ROLES: readonly AgentRole[] = ["sales-sdr", "account-manager", "chief-of-staff"];

export function isKnownRole(role: string): role is AgentRole {
  return (KNOWN_ROLES as readonly string[]).includes(role);
}

/** kbRoot/roles/<role> — where the setup wizard writes (and kb ingestion prefers) a role's knowledge base. */
export function roleOverrideDir(config: AgyhqConfig, role: string): string {
  return path.join(config.kbRoot, ROLE_OVERRIDE_SUBDIR, role);
}

/**
 * Where a role's KB markdown lives: the override directory if it contains any .md, else templates/<role>/kb.
 * When an override exists the template kb for that role is NOT ingested.
 */
export function roleKbSource(config: AgyhqConfig, role: string): { dir: string; source: "override" | "template"; files: string[] } {
  const overrideDir = roleOverrideDir(config, role);
  const overrideFiles = listMarkdownFiles(overrideDir, false);
  if (overrideFiles.length > 0) return { dir: overrideDir, source: "override", files: overrideFiles };
  const templateDir = path.join(config.templatesRoot, role, "kb");
  return { dir: templateDir, source: "template", files: listMarkdownFiles(templateDir, false) };
}

function listMarkdownFiles(dir: string, recursive: boolean, skipTopLevel: readonly string[] = []): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipTopLevel.includes(entry.name)) continue;
      if (recursive) out.push(...listMarkdownFiles(abs, recursive));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(abs);
    }
  }
  return out.sort();
}

function titleFromMarkdown(body: string, fallback: string): string {
  const headingMatch = body.match(/^\s*#\s+(.+)$/m);
  return headingMatch?.[1]?.trim() || fallback;
}

function substituteCompanyName(body: string, companyName: string): string {
  return body.replaceAll("{{companyName}}", companyName);
}

/** Upsert every markdown file in `files` under `scope`; returns the result per file. */
function syncFiles(ctx: KbIngestCtx, files: string[], scope: KbScope): KbSyncResult[] {
  const out: KbSyncResult[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const body = substituteCompanyName(raw, ctx.config.companyName);
    const title = titleFromMarkdown(body, path.basename(file, ".md"));
    const { changed } = ctx.db.kb.upsertDocument({ scope, title, sourcePath: file, body });
    out.push({ scope, sourcePath: file, changed });
  }
  return out;
}

/** Sync exactly one markdown file (e.g. after an admin UI edit) — same upsert path `syncKb` uses internally. */
export function syncOneFile(ctx: KbIngestCtx, file: string, scope: KbScope): KbSyncResult {
  return syncFiles(ctx, [file], scope)[0]!;
}

/** Delete any indexed document in `scope` whose source file is no longer in `currentPaths`. */
function pruneMissing(ctx: KbIngestCtx, scope: KbScope, currentPaths: Set<string>): number {
  let deleted = 0;
  for (const doc of ctx.db.kb.listDocuments(scope)) {
    if (!currentPaths.has(doc.sourcePath)) {
      ctx.db.kb.deleteDocument(doc.id);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Sync all three KB layers:
 *  - company:        kbRoot/**\/*.md               -> scope "company"
 *  - role:<role>:     kbRoot/roles/<role>/*.md if any exist, else templates/<role>/kb/*.md -> scope "role:<role>"
 *  - agent:<id>:      <workspace>/kb/*.md (if present) -> scope "agent:<id>"
 */
export function syncKb(ctx: KbIngestCtx): KbSyncSummary {
  const results: KbSyncResult[] = [];

  // Company KB (recursive) — except kbRoot/roles/, which is role-scope (below), not company-wide.
  const companyFiles = listMarkdownFiles(ctx.config.kbRoot, true, [ROLE_OVERRIDE_SUBDIR]);
  results.push(...syncFiles(ctx, companyFiles, "company"));

  // Role KB (one level): kbRoot/roles/<role>/*.md wins over templates/<role>/kb/*.md; never both.
  const roles = new Set<string>(listTemplateRoles(ctx.config.templatesRoot));
  for (const r of KNOWN_ROLES) if (fs.existsSync(roleOverrideDir(ctx.config, r))) roles.add(r);
  let roleDeleted = 0;
  for (const role of roles) {
    if (!isKnownRole(role)) continue;
    const scope = `role:${role}` as KbScope;
    const roleFiles = roleKbSource(ctx.config, role).files;
    results.push(...syncFiles(ctx, roleFiles, scope));
    roleDeleted += pruneMissing(ctx, scope, new Set(roleFiles));
  }

  // Agent KB (one level, per agent, only if <workspace>/kb exists).
  let agentDeleted = 0;
  for (const agent of ctx.db.agents.list()) {
    const scope = `agent:${agent.id}` as KbScope;
    const agentKbDir = path.join(agent.workspacePath, "kb");
    const agentFiles = listMarkdownFiles(agentKbDir, false);
    results.push(...syncFiles(ctx, agentFiles, scope));
    agentDeleted += pruneMissing(ctx, scope, new Set(agentFiles));
  }

  const companyDeleted = pruneMissing(ctx, "company", new Set(companyFiles));

  return {
    scanned: results.length,
    changed: results.filter((r) => r.changed).length,
    deleted: companyDeleted + roleDeleted + agentDeleted,
    results,
  };
}
