// Per-role KPIs (GET /v1/admin/kpis, and the numbers inside the daily digest).
// Pure read-side aggregation over @agyhq/db — nothing new is persisted. Counts
// are real counts (0 included); rates and medians are null when there is
// nothing to divide, never a made-up 0. Definitions: docs/PHASE4.md §7 and the
// "Phase 4 additions" block of admin-types.ts.

import type { Db } from "@agyhq/db";
import { isReplacedDraft } from "@agyhq/core";
import type { OutboxItem } from "@agyhq/core";
import type { AmKpis, CommonKpis, CosKpis, FanpageKpis, KpiReport, SdrKpis } from "./admin-types.ts";
import { median, summarizeDecisions } from "./quality/scorecard.ts";

const DAY_MS = 86_400_000;

interface TaskRow {
  kind: string;
  status: string;
  result: string | null;
  role: string;
}

function parseResultData(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const data = (JSON.parse(raw) as { data?: unknown } | null)?.data;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function decisionAction(raw: string | null): string | null {
  const decision = parseResultData(raw)["decision"];
  const action = decision && typeof decision === "object" ? (decision as Record<string, unknown>)["action"] : null;
  return typeof action === "string" ? action : null;
}

/** KPIs over the last `days` days. */
export function computeKpis(db: Db, days: number, now: Date = new Date()): KpiReport {
  return computeKpisSince(db, new Date(now.getTime() - days * DAY_MS), now);
}

/** KPIs over [since, now] — the digest uses an hours-based window. `windowDays` is the (possibly fractional) length. */
export function computeKpisSince(db: Db, since: Date, now: Date = new Date()): KpiReport {
  const sinceIso = since.toISOString();
  const windowDays = Math.round(((now.getTime() - since.getTime()) / DAY_MS) * 100) / 100;

  const agents = db.agents.list();
  const roleOf = new Map(agents.map((a) => [a.id, a.role as string]));
  const agentCount = (role: string) => agents.filter((a) => a.role === role && a.status !== "archived").length;

  const tasks = db.sqlite
    .prepare(
      `SELECT t.kind, t.status, t.result, a.role FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.created_at >= ?`,
    )
    .all(sinceIso) as TaskRow[];
  const taskCount = (role: string, kind: string, status?: string) =>
    tasks.filter((t) => t.role === role && t.kind === kind && (status === undefined || t.status === status)).length;

  // -- drafts ---------------------------------------------------------------
  const drafts: OutboxItem[] = db.outbox.list({}).filter((i) => i.createdAt >= sinceIso && !isReplacedDraft(i));
  const taskKindCache = new Map<string, string | null>();
  const kindOf = (taskId: string | null): string | null => {
    if (!taskId) return null;
    if (!taskKindCache.has(taskId)) taskKindCache.set(taskId, db.tasks.get(taskId)?.kind ?? null);
    return taskKindCache.get(taskId)!;
  };
  const draftsOfKind = (role: string, kind: string) => drafts.filter((i) => roleOf.get(i.agentId) === role && kindOf(i.taskId) === kind).length;

  const sentRows = db.sqlite
    .prepare(`SELECT agent_id FROM outbox WHERE status = 'sent' AND COALESCE(sent_at, updated_at) >= ?`)
    .all(sinceIso) as { agent_id: string }[];
  const sentBy = (role: string) => sentRows.filter((r) => roleOf.get(r.agent_id) === role).length;

  // -- shared queries -------------------------------------------------------------
  const stageChanges = (stage: string): number =>
    (
      db.sqlite
        .prepare(
          `SELECT COUNT(DISTINCT subject_id) AS c FROM notes
           WHERE subject_type = 'contact' AND created_at >= ? AND body LIKE ?`,
        )
        .get(sinceIso, `Stage changed to ${stage}:%`) as { c: number }
    ).c;

  // Hand-offs to a human: every transition into waiting_approval, tied to its task so the role/kind is known.
  const escalationRows = db.sqlite
    .prepare(
      `SELECT t.kind AS kind, a.role AS role FROM audit x
       JOIN tasks t ON t.id = x.task_id JOIN agents a ON a.id = t.agent_id
       WHERE x.kind = 'task.transition' AND x.at >= ? AND json_extract(x.data, '$.to') = 'waiting_approval'`,
    )
    .all(sinceIso) as { kind: string; role: string }[];

  const handoffs = (
    db.sqlite.prepare(`SELECT COUNT(*) AS c FROM audit WHERE kind = 'contact.handoff' AND at >= ?`).get(sinceIso) as { c: number }
  ).c;

  // -- sales-sdr -------------------------------------------------------------------
  const replyRows = db.sqlite
    .prepare(
      `SELECT a.role AS role FROM inbound_events e
       JOIN tasks t ON t.id = e.routed_task_id JOIN agents a ON a.id = t.agent_id
       WHERE e.classification = 'reply' AND e.received_at >= ?`,
    )
    .all(sinceIso) as { role: string }[];
  const sdrSent = sentBy("sales-sdr");
  const sdrReplies = replyRows.filter((r) => r.role === "sales-sdr").length;
  const sdr: SdrKpis = {
    agents: agentCount("sales-sdr"),
    leadsResearched: taskCount("sales-sdr", "sdr.research_lead", "done"),
    firstTouchDrafted: draftsOfKind("sales-sdr", "sdr.first_touch"),
    emailsSent: sdrSent,
    replies: sdrReplies,
    replyRate: sdrSent > 0 ? Math.min(1, sdrReplies / sdrSent) : null,
    qualified: stageChanges("qualified"),
    meetingsBooked: stageChanges("meeting_booked"),
    handoffs,
  };

  // -- account-manager -------------------------------------------------------------
  const handled = db.sqlite
    .prepare(
      `SELECT e.received_at AS received_at,
              (SELECT MIN(COALESCE(o.sent_at, o.updated_at)) FROM outbox o WHERE o.task_id = t.id AND o.status = 'sent') AS answered_at
       FROM inbound_events e
       JOIN tasks t ON t.id = e.routed_task_id JOIN agents a ON a.id = t.agent_id
       WHERE e.received_at >= ? AND a.role = 'account-manager' AND t.kind = 'am.handle_message'`,
    )
    .all(sinceIso) as { received_at: string; answered_at: string | null }[];
  const responseMinutes = handled
    .filter((h) => h.answered_at !== null)
    .map((h) => (Date.parse(h.answered_at!) - Date.parse(h.received_at)) / 60_000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  const am: AmKpis = {
    agents: agentCount("account-manager"),
    accounts: (db.sqlite.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE stage = 'customer'`).get() as { c: number }).c,
    messagesHandled: taskCount("account-manager", "am.handle_message", "done"),
    medianFirstResponseMinutes: median(responseMinutes),
    escalations: escalationRows.filter((r) => r.role === "account-manager").length,
    checkInsDrafted: draftsOfKind("account-manager", "am.check_in"),
    churned: stageChanges("churned"),
  };

  // -- chief-of-staff --------------------------------------------------------------
  const triage = tasks.filter((t) => t.role === "chief-of-staff" && t.kind === "cos.triage");
  const cos: CosKpis = {
    agents: agentCount("chief-of-staff"),
    triaged: triage.filter((t) => t.status === "done" || t.status === "waiting_approval").length,
    delegated: triage.filter((t) => t.status === "done" && decisionAction(t.result) === "delegated").length,
    escalated: escalationRows.filter((r) => r.role === "chief-of-staff" && r.kind === "cos.triage").length,
    digests: (db.sqlite.prepare(`SELECT COUNT(*) AS c FROM briefings WHERE created_at >= ?`).get(sinceIso) as { c: number }).c,
  };

  // -- fanpage-manager ---------------------------------------------------------------
  const fbDrafts = (channel: string) => drafts.filter((i) => roleOf.get(i.agentId) === "fanpage-manager" && i.channel === channel).length;
  const fbSent = (channel: string) =>
    (
      db.sqlite
        .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'sent' AND channel = ? AND COALESCE(sent_at, updated_at) >= ?`)
        .get(channel, sinceIso) as { c: number }
    ).c;
  const fanpageHandoffs = (
    db.sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks c JOIN tasks p ON p.id = c.parent_task_id JOIN agents a ON a.id = p.agent_id
         WHERE c.created_at >= ? AND a.role = 'fanpage-manager' AND p.kind = 'fanpage.reply_comment' AND c.agent_id != p.agent_id`,
      )
      .get(sinceIso) as { c: number }
  ).c;
  const fanpage: FanpageKpis = {
    agents: agentCount("fanpage-manager"),
    postsDrafted: fbDrafts("facebook_post"),
    postsScheduled: fbSent("facebook_post"),
    commentsReceived: db.facebook.countCommentsSince(sinceIso),
    repliesDrafted: fbDrafts("facebook_reply"),
    repliesSent: fbSent("facebook_reply"),
    hideProposals: fbDrafts("facebook_hide"),
    escalations: escalationRows.filter((r) => r.role === "fanpage-manager").length,
    handoffs: fanpageHandoffs,
  };

  // -- common ------------------------------------------------------------------------
  const decisions = summarizeDecisions(drafts);
  const common: CommonKpis = {
    tasksDone: tasks.filter((t) => t.status === "done").length,
    tasksFailed: tasks.filter((t) => t.status === "failed").length,
    needsHuman: escalationRows.length,
    approvalRate: decisions.approvalRate,
    medianEditRatio: decisions.medianEditRatio,
  };

  return { windowDays, roles: { "sales-sdr": sdr, "account-manager": am, "chief-of-staff": cos, "fanpage-manager": fanpage }, common };
}
