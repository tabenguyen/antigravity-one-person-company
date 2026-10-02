// Seeding helpers for the quality tests (scorecards, promotion).
import type { LintFinding, OutboxStatus, RejectionCategory, TrustTier } from "@agyhq/core";
import type { Db } from "@agyhq/db";

export function addAgent(db: Db, id = "sdr-01", trustTier: TrustTier = "shadow") {
  return db.agents.create({
    id,
    role: "sales-sdr",
    displayName: id,
    model: "m",
    workspacePath: `/tmp/${id}`,
    policy: { builtins: [], mcp: [] },
    trustTier,
  });
}

export interface SeedDraft {
  to?: string;
  /** What the agent wrote. */
  original?: string;
  /** What was finally sent (differs from `original` when a human edited it). */
  final?: string;
  status: "held" | "sent" | "approved" | "rejected" | "pending_approval";
  decidedBy?: string;
  category?: RejectionCategory;
  /** createdAt is this many minutes before decidedAt (human review time). */
  reviewMinutes?: number;
  /** Age of decidedAt (or now for undecided) in days. */
  daysAgo?: number;
  lint?: LintFinding[];
  threadKey?: string;
  messageId?: string;
}

/** Create an outbox item and walk it through the real state machine, then back-date its timestamps. */
export function seedDraft(db: Db, agentId: string, d: SeedDraft) {
  const original = d.original ?? "Original body";
  const draft = db.outbox.createDraft({
    agentId,
    channel: "email",
    to: d.to ?? "lead@acme.com",
    subject: "Hello",
    body: original,
    reason: "r",
    threadKey: d.threadKey ?? null,
    lint: d.lint,
  });
  if (d.final !== undefined && d.final !== original) db.outbox.edit(draft.id, { body: d.final });
  const decidedAtMs = Date.now() - (d.daysAgo ?? 1) * 86_400_000;
  const decidedAt = new Date(decidedAtMs).toISOString();
  const createdAt = new Date(decidedAtMs - (d.reviewMinutes ?? 10) * 60_000).toISOString();
  const by = d.decidedBy ?? "human:ops";
  const patch = { decidedBy: by, decidedAt };
  const to = (s: OutboxStatus, extra: object = {}) => db.outbox.decide(draft.id, s, extra);
  switch (d.status) {
    case "held":
      to("held", patch);
      break;
    case "approved":
      to("approved", patch);
      break;
    case "sent":
      to("approved", patch);
      to("sending");
      to("sent", { sentAt: decidedAt, messageId: d.messageId ?? null });
      break;
    case "rejected":
      to("rejected", { ...patch, rejectionCategory: d.category ?? null, decisionNote: "no" });
      break;
    case "pending_approval":
      break;
  }
  db.sqlite.prepare("UPDATE outbox SET created_at = ? WHERE id = ?").run(createdAt, draft.id);
  return db.outbox.get(draft.id)!;
}
