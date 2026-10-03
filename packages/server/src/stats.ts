// Dashboard stats (GET /v1/admin/stats?days=). Pure read-side aggregation
// over @agyhq/db — no new persistence, just queries scoped to a time window.

import type { Db } from "@agyhq/db";
import { isReplacedDraft } from "@agyhq/core";
import type { AgyUsage, OutboxStatus, TaskStatus } from "@agyhq/core";
import type { AgentStats } from "./admin-types.ts";

export interface StatsData {
  days: number;
  agents: AgentStats[];
  inboundToday: number;
  sentToday: number;
}

function startOfTodayIso(now = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function computeStats(db: Db, days: number, now: Date = new Date()): StatsData {
  const sinceIso = new Date(now.getTime() - days * 24 * 3_600_000).toISOString();
  const todayIso = startOfTodayIso(now);

  const agents: AgentStats[] = db.agents.list().map((agent) => {
    const tasks = db.tasks.list({ agentId: agent.id }).filter((t) => t.createdAt >= sinceIso);
    const tasksByStatus: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasks) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;

    const outboxItems = db.outbox.list({ agentId: agent.id }).filter((i) => i.createdAt >= sinceIso && !isReplacedDraft(i));
    const outboxByStatus: Partial<Record<OutboxStatus, number>> = {};
    for (const i of outboxItems) outboxByStatus[i.status] = (outboxByStatus[i.status] ?? 0) + 1;

    const decided = outboxItems.filter((i) => i.decidedBy !== null);
    const approvedOrHeld = decided.filter((i) => i.status === "approved" || i.status === "held" || i.status === "sent" || i.status === "sending" || i.status === "failed");
    const approvalRate = decided.length > 0 ? approvedOrHeld.length / decided.length : null;
    const editedAmongApproved = approvedOrHeld.filter((i) => i.editedByHuman);
    const editRate = approvedOrHeld.length > 0 ? editedAmongApproved.length / approvedOrHeld.length : null;

    const sent = outboxItems.filter((i) => i.status === "sent").length;

    const repliesReceived = db.inbound
      .list({ classification: "reply" })
      .filter((e) => e.receivedAt >= sinceIso && e.routedTaskId && db.tasks.get(e.routedTaskId)?.agentId === agent.id).length;

    const runFinished = db.audit.list({ agentId: agent.id, kind: ["run.finished"], since: sinceIso });
    const tokensUsed = runFinished.reduce((sum, ev) => {
      const usage = (ev.data as { usage?: AgyUsage | null }).usage;
      return sum + (usage?.totalTokens ?? 0);
    }, 0);

    return { agentId: agent.id, tasksByStatus, outboxByStatus, approvalRate, editRate, sent, repliesReceived, tokensUsed };
  });

  const inboundToday = db.inbound.list().filter((e) => e.receivedAt >= todayIso).length;
  const sentToday = db.outbox.list({ status: ["sent"] }).filter((i) => (i.sentAt ?? i.updatedAt) >= todayIso).length;

  return { days, agents, inboundToday, sentToday };
}
