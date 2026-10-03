// db-backed LintContext builders: gather the contact, KB text, company profile
// and thread history the pure lint engine needs.

import type { Agent, CompanyProfile, KbScope, LintFinding, OutboxItem } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { lintDraft, type LintContext } from "./lint.ts";

export interface BuildLintContextArgs {
  agent: Pick<Agent, "id" | "role">;
  to: string;
  threadKey?: string | null;
  /** The stored item being re-linted, so it doesn't count as its own prior thread. */
  excludeOutboxId?: string | null;
}

/** Does this recipient have a real prior thread: inbound mail from them, or a sent/approved email to them? */
export function hasPriorThread(db: Db, to: string, threadKey?: string | null, excludeOutboxId?: string | null): boolean {
  const addr = to.trim().toLowerCase();
  const inbound = db.sqlite
    .prepare(
      `SELECT 1 FROM inbound_events
       WHERE lower(from_address) = @addr OR (@threadKey IS NOT NULL AND thread_key = @threadKey)
       LIMIT 1`,
    )
    .get({ addr, threadKey: threadKey ?? null });
  if (inbound) return true;
  const outbound = db.sqlite
    .prepare(
      `SELECT 1 FROM outbox
       WHERE status IN ('sent', 'sending', 'approved') AND id != @self
         AND (lower("to") = @addr OR (@threadKey IS NOT NULL AND thread_key = @threadKey))
       LIMIT 1`,
    )
    .get({ addr, threadKey: threadKey ?? null, self: excludeOutboxId ?? "" });
  return outbound !== undefined;
}

/** Subjects of the contact's recent inbound mail (from their address, or on this thread), newest first. */
export function threadInboundSubjects(db: Db, to: string, threadKey?: string | null, limit = 8): string[] {
  const rows = db.sqlite
    .prepare(
      `SELECT subject FROM inbound_events
       WHERE subject IS NOT NULL AND trim(subject) != ''
         AND (lower(from_address) = @addr OR (@threadKey IS NOT NULL AND thread_key = @threadKey))
       ORDER BY received_at DESC LIMIT @limit`,
    )
    .all({ addr: to.trim().toLowerCase(), threadKey: threadKey ?? null, limit }) as { subject: string }[];
  return [...new Set(rows.map((r) => r.subject))];
}

/**
 * Lines that tell the agent what NOT to say ("Không báo giá 50.000đ/tháng", "never quote $99") mention
 * prices precisely so they are avoided — they must not count as grounding for those prices.
 */
const NEGATED_LINE =
  /(không|đừng|cấm|never|do not|don't|must not)\s+(?:được\s+|bao giờ\s+)?(?:báo giá|nhắc|nêu|đưa|hứa|cam kết|quote|mention|offer|promise|claim|say)/i;

export function groundingText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !NEGATED_LINE.test(line))
    .join("\n");
}

/**
 * KB text that can ground prices/claims in a draft: company + role + agent scopes plus the company profile,
 * excluding the forbidden-claims document and negated "don't say X" lines.
 */
export function loadKbText(db: Db, agent: Pick<Agent, "id" | "role">): string {
  const scopes: KbScope[] = ["company", `role:${agent.role}`, `agent:${agent.id}`];
  const parts: string[] = [];
  for (const scope of scopes) {
    for (const doc of db.kb.listDocuments(scope)) {
      if (doc.sourcePath?.endsWith("forbidden-claims.md")) continue;
      parts.push(doc.body);
    }
  }
  const profile = db.kv.get<CompanyProfile>("company_profile");
  if (profile) parts.push(profile.pricingPolicy ?? "", profile.proofPoints ?? "", profile.productDescription ?? "");
  return groundingText(parts.join("\n\n"));
}

export function buildLintContext(db: Db, args: BuildLintContextArgs): LintContext {
  const contact = db.crm.findContacts({ email: args.to })[0] ?? null;
  const profile = db.kv.get<CompanyProfile>("company_profile");
  const prior = hasPriorThread(db, args.to, args.threadKey, args.excludeOutboxId);
  let kbCache: string | null = null;
  return {
    contact: contact ? { name: contact.name, language: contact.language, company: contact.company?.name ?? null } : null,
    kbText: () => (kbCache ??= loadKbText(db, args.agent)),
    profile: profile ? { meetingLink: profile.meetingLink, forbiddenClaims: profile.forbiddenClaims } : null,
    role: args.agent.role,
    hasPriorThread: prior,
    firstTouch: !prior,
    threadSubjects: prior ? threadInboundSubjects(db, args.to, args.threadKey) : [],
  };
}

/** Lint a draft that is not yet persisted (draft-time enforcement). */
export function lintNewDraft(
  db: Db,
  args: BuildLintContextArgs & { subject: string | null; body: string },
): LintFinding[] {
  return lintDraft({ subject: args.subject, body: args.body, to: args.to }, buildLintContext(db, args));
}

/** Re-lint a stored outbox item with the current KB/profile/contact data (after a human edit, or on demand). */
export function lintOutboxItem(db: Db, item: Pick<OutboxItem, "id" | "agentId" | "to" | "subject" | "body" | "threadKey">): LintFinding[] {
  const agent = db.agents.get(item.agentId);
  if (!agent) return lintDraft({ subject: item.subject, body: item.body, to: item.to });
  return lintNewDraft(db, { agent, to: item.to, threadKey: item.threadKey, excludeOutboxId: item.id, subject: item.subject, body: item.body });
}
