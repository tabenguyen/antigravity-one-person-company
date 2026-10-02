// Executes one routine: turns it into queued tasks. Pure db work (no model calls,
// no network), so a whole run is one SQLite transaction — either the tasks AND the
// routine's lastRun/nextRun bookkeeping are saved, or neither is.

import type { Agent, Iso, LeadStage, Routine, Task } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { EventBus } from "../event-bus.ts";
import { nextRun } from "./cron.ts";
import type { AccountReviewEntry, DigestSnapshot } from "../admin-types.ts";
import { DAILY_DIGEST_KIND } from "../briefings.ts";
import { computeKpisSince } from "../kpis.ts";
import { buildShadowDigest } from "../shadow.ts";
import { parseProspectingConfig, AccountReviewConfigZ, CustomTaskConfigZ, DailyDigestConfigZ, PipelineReviewConfigZ } from "./config.ts";

export const RESEARCH_KIND = "sdr.research_lead";
export const PIPELINE_REVIEW_KIND = "sdr.pipeline_review";
export const ACCOUNT_REVIEW_KIND = "am.account_review";

/** A contact is "in flight" when an unfinished task sits on its thread. */
const OPEN_TASK_STATUSES = ["queued", "running", "waiting_approval", "waiting_external"] as const;

export interface RoutineRunDeps {
  db: Db;
  bus?: EventBus;
  now?: () => Date;
}

export interface RoutineRunOutcome {
  routineId: string;
  /** Short human-readable outcome, also stored as routine.lastResult. */
  result: string;
  /** True when nothing was attempted (agent paused/archived/missing). */
  skipped: boolean;
  taskIds: string[];
}

/** Next scheduled instant strictly after `from`, or null when the routine is disabled / its schedule is unusable. */
export function computeNextRunAt(routine: Pick<Routine, "schedule" | "timezone" | "enabled">, from: Date): Iso | null {
  if (!routine.enabled) return null;
  try {
    return nextRun(routine.schedule, routine.timezone, from).toISOString();
  } catch {
    return null;
  }
}

interface ContactRow {
  id: string;
  email: string;
  stage: LeadStage;
  owner_agent_id: string | null;
  attributes: string;
}

function parseAttrs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isOptedOut(attrs: Record<string, unknown>): boolean {
  return attrs["optOut"] === true || Boolean(attrs["doNotContact"]) || Boolean(attrs["emailBounced"]);
}

function openThreadKeys(db: Db): Set<string> {
  const rows = db.sqlite
    .prepare(
      `SELECT DISTINCT thread_key FROM tasks
       WHERE thread_key IS NOT NULL AND status IN (${OPEN_TASK_STATUSES.map(() => "?").join(",")})`,
    )
    .all(...OPEN_TASK_STATUSES) as { thread_key: string }[];
  return new Set(rows.map((r) => r.thread_key.toLowerCase()));
}

// ---------------------------------------------------------------------------
// prospecting

function runProspecting(deps: RoutineRunDeps, routine: Routine, agent: Agent): { result: string; taskIds: string[] } {
  const { db } = deps;
  const cfg = parseProspectingConfig(routine.config);
  const stagePlaceholders = cfg.stages.map(() => "?").join(",");
  const rows = db.sqlite
    .prepare(
      `SELECT id, email, stage, owner_agent_id, attributes FROM contacts
       WHERE email IS NOT NULL AND stage IN (${stagePlaceholders})
         AND (owner_agent_id IS NULL OR owner_agent_id = ?)
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...cfg.stages, agent.id) as ContactRow[];

  const busyThreads = openThreadKeys(db);
  const eligible = rows.filter((r) => !isOptedOut(parseAttrs(r.attributes)) && !busyThreads.has(`contact:${r.email}`.toLowerCase()));

  const taskIds: string[] = [];
  for (const row of eligible.slice(0, cfg.batchSize)) {
    const view = db.crm.contactView(row.id);
    if (!view || !view.email) continue;
    if (!view.ownerAgentId) db.crm.upsertContact({ email: view.email, ownerAgentId: agent.id });
    if (view.stage === "new") {
      db.crm.setStage(view.id, "researching", `queued for research by routine "${routine.name}"`, agent.id);
    }
    const task = db.tasks.create({
      agentId: agent.id,
      kind: RESEARCH_KIND,
      title: `Research ${view.name ?? view.email}`,
      input: {
        contactName: view.name,
        contactEmail: view.email,
        leadCompanyName: view.company?.name ?? null,
        leadCompanyDomain: view.company?.domain ?? null,
        context: buildContext(view, routine),
      },
      threadKey: `contact:${view.email}`,
      priority: 1,
    });
    taskIds.push(task.id);
  }
  const n = taskIds.length;
  return { result: `queued ${n} research task${n === 1 ? "" : "s"} (${eligible.length} eligible)`, taskIds };
}

function buildContext(view: NonNullable<ReturnType<Db["crm"]["contactView"]>>, routine: Routine): string {
  const bits = [`Outbound prospecting (routine "${routine.name}"). Lead source: ${view.source ?? "unknown"}.`];
  if (view.title) bits.push(`Title: ${view.title}.`);
  const co = view.company;
  if (co) {
    const facts = [co.industry && `industry ${co.industry}`, co.size && `size ${co.size}`, co.country && `country ${co.country}`].filter(Boolean);
    if (facts.length) bits.push(`Company facts on file: ${facts.join(", ")}.`);
  }
  if (view.language) bits.push(`Preferred language: ${view.language}.`);
  return bits.join(" ");
}

// ---------------------------------------------------------------------------
// pipeline_review

interface PipelineEntry {
  contactId: string;
  email: string;
  name: string | null;
  company: string | null;
  stage: LeadStage;
  lastTouchAt: Iso | null;
  daysSinceLastTouch: number | null;
  lastReplyAt: Iso | null;
  repliedSinceLastTouch: boolean;
  openTasks: { kind: string; status: string; wakeAt: Iso | null }[];
  /** Deterministic hint: contacted > N days ago, no reply, nothing scheduled. The agent verifies before acting. */
  staleHint: boolean;
}

const PIPELINE_STAGES: LeadStage[] = ["researching", "contacted", "replied", "qualified", "meeting_booked", "nurture"];

export function buildPipelineSnapshot(db: Db, agentId: string, now: Date, maxContacts: number, staleAfterDays: number): PipelineEntry[] {
  const rows = db.sqlite
    .prepare(
      `SELECT c.id, c.email, c.name, c.stage, c.attributes, co.name AS company
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.owner_agent_id = ? AND c.email IS NOT NULL AND c.stage IN (${PIPELINE_STAGES.map(() => "?").join(",")})`,
    )
    .all(agentId, ...PIPELINE_STAGES) as (ContactRow & { name: string | null; company: string | null })[];

  const lastTouch = db.sqlite.prepare(
    `SELECT MAX(COALESCE(sent_at, decided_at, created_at)) AS at FROM outbox
     WHERE agent_id = ? AND lower("to") = ? AND status IN ('sent','held','approved','sending')`,
  );
  const lastReply = db.sqlite.prepare(
    `SELECT MAX(received_at) AS at FROM inbound_events WHERE lower(from_address) = ? AND classification = 'reply'`,
  );
  const openTasks = db.sqlite.prepare(
    `SELECT kind, status, wake_at FROM tasks WHERE thread_key = ? AND status IN (${OPEN_TASK_STATUSES.map(() => "?").join(",")})`,
  );

  const entries: PipelineEntry[] = rows
    .filter((r) => !isOptedOut(parseAttrs(r.attributes)))
    .map((r) => {
      const email = r.email.toLowerCase();
      // A human emailing them from their own mail client (Sent-folder sync) is a touch too: no "stale, chase again" hint.
      const touchAt = [(lastTouch.get(agentId, email) as { at: string | null }).at, db.humanSent.lastSentTo(email)].filter((x): x is string => !!x).sort().pop() ?? null;
      const replyAt = (lastReply.get(email) as { at: string | null }).at;
      const tasks = (openTasks.all(`contact:${email}`, ...OPEN_TASK_STATUSES) as { kind: string; status: string; wake_at: string | null }[]).map(
        (t) => ({ kind: t.kind, status: t.status, wakeAt: t.wake_at }),
      );
      const days = touchAt ? Math.floor((now.getTime() - new Date(touchAt).getTime()) / 86_400_000) : null;
      const repliedSince = Boolean(replyAt && touchAt && replyAt > touchAt);
      return {
        contactId: r.id,
        email,
        name: r.name,
        company: r.company,
        stage: r.stage,
        lastTouchAt: touchAt,
        daysSinceLastTouch: days,
        lastReplyAt: replyAt,
        repliedSinceLastTouch: repliedSince,
        openTasks: tasks,
        staleHint: r.stage === "contacted" && days !== null && days > staleAfterDays && !repliedSince && tasks.length === 0,
      };
    });
  // Stale first, then oldest touch first, so the cap drops the least interesting contacts.
  entries.sort((a, b) => Number(b.staleHint) - Number(a.staleHint) || (b.daysSinceLastTouch ?? -1) - (a.daysSinceLastTouch ?? -1));
  return entries.slice(0, maxContacts);
}

function runPipelineReview(deps: RoutineRunDeps, routine: Routine, agent: Agent, now: Date): { result: string; taskIds: string[] } {
  const { db } = deps;
  const open = db.tasks.list({ agentId: agent.id, status: ["queued", "running"] }).find((t) => t.kind === PIPELINE_REVIEW_KIND);
  if (open) return { result: `skipped: previous pipeline review (${open.id}) is still ${open.status}`, taskIds: [] };

  const cfg = PipelineReviewConfigZ.safeParse(routine.config);
  const { maxContacts, staleAfterDays } = cfg.success ? cfg.data : { maxContacts: 40, staleAfterDays: 7 };
  const snapshot = buildPipelineSnapshot(db, agent.id, now, maxContacts, staleAfterDays);
  const stale = snapshot.filter((e) => e.staleHint).length;
  const task = db.tasks.create({
    agentId: agent.id,
    kind: PIPELINE_REVIEW_KIND,
    title: `Pipeline review ${now.toISOString().slice(0, 10)}`,
    input: {
      routineName: routine.name,
      reviewDate: now.toISOString(),
      staleAfterDays,
      pipelineSnapshot: snapshot,
    },
    priority: 0,
  });
  return { result: `queued pipeline review (${snapshot.length} contacts, ${stale} likely stale)`, taskIds: [task.id] };
}

// ---------------------------------------------------------------------------
// account_review (Account Manager)

export function buildAccountSnapshot(db: Db, agentId: string, now: Date, maxAccounts: number, staleAfterDays: number): AccountReviewEntry[] {
  const rows = db.sqlite
    .prepare(
      `SELECT c.id, c.email, c.name, c.stage, c.attributes, c.updated_at, co.name AS company
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.owner_agent_id = ? AND c.stage = 'customer' AND c.email IS NOT NULL`,
    )
    .all(agentId) as (ContactRow & { name: string | null; company: string | null; updated_at: string })[];

  const lastSent = db.sqlite.prepare(`SELECT MAX(COALESCE(sent_at, updated_at)) AS at FROM outbox WHERE lower("to") = ? AND status = 'sent'`);
  const lastInbound = db.sqlite.prepare(
    `SELECT MAX(received_at) AS at FROM inbound_events WHERE lower(from_address) = ? AND classification IN ('reply', 'new_lead')`,
  );
  const openTasks = db.sqlite.prepare(
    `SELECT kind, status, wake_at FROM tasks WHERE thread_key = ? AND status IN (${OPEN_TASK_STATUSES.map(() => "?").join(",")})`,
  );

  const entries: AccountReviewEntry[] = rows
    .filter((r) => !isOptedOut(parseAttrs(r.attributes)))
    .map((r) => {
      const email = r.email.toLowerCase();
      const sentAt = (lastSent.get(email) as { at: string | null }).at;
      const inboundAt = (lastInbound.get(email) as { at: string | null }).at;
      const activityAt = [sentAt, inboundAt, db.humanSent.lastSentTo(email)].filter((x): x is string => !!x).sort().pop() ?? null;
      const basis = activityAt ?? r.updated_at;
      const days = Math.max(0, Math.floor((now.getTime() - new Date(basis).getTime()) / 86_400_000));
      const tasks = (openTasks.all(`contact:${email}`, ...OPEN_TASK_STATUSES) as { kind: string; status: string; wake_at: string | null }[]).map(
        (t) => ({ kind: t.kind, status: t.status, wakeAt: t.wake_at }),
      );
      return {
        contactId: r.id,
        name: r.name,
        email,
        company: r.company,
        stage: r.stage,
        lastActivityAt: activityAt,
        daysSinceActivity: days,
        openTasks: tasks,
        staleHint: days > staleAfterDays && tasks.length === 0,
      };
    });
  // Stale first, then quietest first, so the cap drops the accounts that need the least attention.
  entries.sort((a, b) => Number(b.staleHint) - Number(a.staleHint) || (b.daysSinceActivity ?? -1) - (a.daysSinceActivity ?? -1));
  return entries.slice(0, maxAccounts);
}

function runAccountReview(deps: RoutineRunDeps, routine: Routine, agent: Agent, now: Date): { result: string; taskIds: string[] } {
  const { db } = deps;
  const open = db.tasks.list({ agentId: agent.id, status: ["queued", "running"] }).find((t) => t.kind === ACCOUNT_REVIEW_KIND);
  if (open) return { result: `skipped: previous account review (${open.id}) is still ${open.status}`, taskIds: [] };

  const cfg = AccountReviewConfigZ.safeParse(routine.config);
  const { maxAccounts, staleAfterDays } = cfg.success ? cfg.data : { maxAccounts: 40, staleAfterDays: 14 };
  const accounts = buildAccountSnapshot(db, agent.id, now, maxAccounts, staleAfterDays);
  if (accounts.length === 0) return { result: "no customer accounts to review", taskIds: [] };

  const stale = accounts.filter((a) => a.staleHint).length;
  const task = db.tasks.create({
    agentId: agent.id,
    kind: ACCOUNT_REVIEW_KIND,
    title: `Account review ${now.toISOString().slice(0, 10)}`,
    input: { routineName: routine.name, reviewDate: now.toISOString().slice(0, 10), staleAfterDays, accounts },
    priority: 0,
  });
  return { result: `queued account review (${accounts.length} accounts, ${stale} likely stale)`, taskIds: [task.id] };
}

// ---------------------------------------------------------------------------
// daily_digest (Chief of Staff)

const DIGEST_LIST_CAP = 20;

export function buildDigestSnapshot(db: Db, since: Date, now: Date): DigestSnapshot {
  const sinceIso = since.toISOString();
  const text = (v: string | null | undefined, max: number): string | null => (v ? (v.length > max ? `${v.slice(0, max)}…` : v) : null);

  const pending = db.outbox.list({ status: ["pending_approval"] }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const failed = db.tasks.list({ status: ["failed"] }).filter((t) => t.updatedAt >= sinceIso);
  const waiting = db.tasks.list({ status: ["waiting_approval"] }).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const contactRows = db.sqlite
    .prepare(
      `SELECT c.id, c.name, c.email, c.source, c.stage, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.created_at >= ? ORDER BY c.created_at DESC, c.rowid DESC`,
    )
    .all(sinceIso) as { id: string; name: string | null; email: string | null; source: string | null; stage: string; company: string | null }[];
  const handoffs = db.audit.list({ kind: ["contact.handoff"], since: sinceIso });

  return {
    kpis: computeKpisSince(db, since, now),
    pendingApprovals: {
      count: pending.length,
      oldestAt: pending[0]?.createdAt ?? null,
      items: pending.slice(0, 10).map((i) => ({ outboxId: i.id, agentId: i.agentId, to: i.to, subject: text(i.subject, 120), createdAt: i.createdAt })),
    },
    failedTasks: {
      count: failed.length,
      items: failed.slice(0, DIGEST_LIST_CAP).map((t) => ({ taskId: t.id, agentId: t.agentId, kind: t.kind, title: t.title, error: text(t.error, 300), at: t.updatedAt })),
    },
    needsHuman: {
      count: waiting.length,
      items: waiting
        .slice(0, DIGEST_LIST_CAP)
        .map((t) => ({ taskId: t.id, agentId: t.agentId, kind: t.kind, title: t.title, summary: text(t.result?.summary, 300), since: t.updatedAt })),
    },
    newContacts: {
      count: contactRows.length,
      items: contactRows.slice(0, DIGEST_LIST_CAP).map((c) => ({ contactId: c.id, name: c.name, email: c.email, company: c.company, source: c.source, stage: c.stage })),
    },
    handoffs: {
      count: handoffs.length,
      items: handoffs.slice(0, DIGEST_LIST_CAP).map((e) => ({
        contactId: String(e.data["contactId"] ?? ""),
        email: typeof e.data["email"] === "string" ? e.data["email"] : null,
        fromAgentId: typeof e.data["fromAgentId"] === "string" ? e.data["fromAgentId"] : null,
        toAgentId: String(e.data["toAgentId"] ?? ""),
        summary: String(e.data["summary"] ?? ""),
        at: e.at,
      })),
    },
    shadowRun: buildShadowDigest(db, since, now),
  };
}

function runDailyDigest(deps: RoutineRunDeps, routine: Routine, agent: Agent, now: Date): { result: string; taskIds: string[] } {
  const { db } = deps;
  const open = db.tasks.list({ agentId: agent.id, status: ["queued", "running"] }).find((t) => t.kind === DAILY_DIGEST_KIND);
  if (open) return { result: `skipped: previous daily digest (${open.id}) is still ${open.status}`, taskIds: [] };

  const cfg = DailyDigestConfigZ.safeParse(routine.config);
  const lookbackHours = cfg.success ? cfg.data.lookbackHours : 24;
  const since = new Date(now.getTime() - lookbackHours * 3_600_000);
  const snapshot = buildDigestSnapshot(db, since, now);
  const task = db.tasks.create({
    agentId: agent.id,
    kind: DAILY_DIGEST_KIND,
    title: `Daily digest ${now.toISOString().slice(0, 10)}`,
    input: { routineName: routine.name, periodStart: since.toISOString(), periodEnd: now.toISOString(), snapshot },
    priority: 0,
  });
  return { result: `queued daily digest (last ${lookbackHours}h: ${snapshot.pendingApprovals.count} pending approvals, ${snapshot.needsHuman.count} need a human)`, taskIds: [task.id] };
}

// ---------------------------------------------------------------------------
// custom_task

function runCustomTask(deps: RoutineRunDeps, routine: Routine, agent: Agent): { result: string; taskIds: string[] } {
  const parsed = CustomTaskConfigZ.safeParse(routine.config);
  if (!parsed.success) {
    return { result: `failed: invalid custom_task config (${parsed.error.issues.map((i) => i.message).join("; ")})`, taskIds: [] };
  }
  const { kind, title, input, priority, threadKey } = parsed.data;
  const task: Task = deps.db.tasks.create({ agentId: agent.id, kind, title, input, priority, threadKey: threadKey ?? null });
  return { result: `queued task ${task.id} (${kind})`, taskIds: [task.id] };
}

// ---------------------------------------------------------------------------

/**
 * Run `routine` now. Scheduled runs (manual=false) advance nextRunAt to the next cron
 * slot after `now` (so several missed slots collapse into this one run); manual runs
 * leave the schedule untouched.
 */
export function runRoutine(deps: RoutineRunDeps, routine: Routine, opts: { manual: boolean }): RoutineRunOutcome {
  const { db, bus } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const agent = db.agents.get(routine.agentId);

  const outcome = db.transaction((): RoutineRunOutcome => {
    let result: string;
    let skipped = false;
    let taskIds: string[] = [];

    if (!agent) {
      result = `skipped: agent "${routine.agentId}" not found`;
      skipped = true;
    } else if (agent.status !== "active") {
      result = `skipped: agent "${agent.id}" is ${agent.status}`;
      skipped = true;
    } else {
      try {
        const r =
          routine.kind === "prospecting"
            ? runProspecting(deps, routine, agent)
            : routine.kind === "pipeline_review"
              ? runPipelineReview(deps, routine, agent, now)
              : routine.kind === "account_review"
                ? runAccountReview(deps, routine, agent, now)
                : routine.kind === "daily_digest"
                  ? runDailyDigest(deps, routine, agent, now)
                  : runCustomTask(deps, routine, agent);
        result = r.result;
        taskIds = r.taskIds;
      } catch (err) {
        result = `failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const nextRunAt = opts.manual ? routine.nextRunAt : computeNextRunAt(routine, now);
    db.routines.markRan(routine.id, result, nextRunAt, now.toISOString());
    db.audit.append({
      kind: "routine.ran",
      agentId: routine.agentId,
      taskId: null,
      conversationId: null,
      data: { routineId: routine.id, name: routine.name, kind: routine.kind, manual: opts.manual, result, skipped, taskIds },
    });
    return { routineId: routine.id, result, skipped, taskIds };
  });

  for (const id of outcome.taskIds) bus?.emit("task.created", { taskId: id, agentId: routine.agentId, routineId: routine.id });
  bus?.emit("routine.ran", { routineId: routine.id, agentId: routine.agentId, result: outcome.result, skipped: outcome.skipped, manual: opts.manual });
  return outcome;
}
