// Shadow run: status, verdicts and trends, computed on read from outbox/audit (nothing but the run itself is
// stored). Per-agent figures come from the scorecard (quality/scorecard.ts) over the run window, and the
// promotion progress is the scorecard's own criteria check, so "on track" can never disagree with "eligible".
// Definitions: see the "Shadow run" block in admin-types.ts.

import type { Agent, OutboxItem, PromotionCriteria, RejectionCategory, ShadowRun } from "@agyhq/core";
import { DEFAULT_SHADOW_PLANNED_DAYS, isReplacedDraft } from "@agyhq/core";
import { ConflictError, type Db } from "@agyhq/db";
import type {
  ShadowAgentStatus,
  ShadowDailyRow,
  ShadowDigestSection,
  ShadowRunStatus,
  ShadowStartCandidate,
  ShadowVerdict,
} from "./admin-types.ts";
import {
  checkCriteria,
  computeScorecardWindow,
  formatPct,
  lintErrorStats,
  loadCriteria,
  median,
  summarizeDecisions,
  type CriterionCheck,
} from "./quality/scorecard.ts";
import { ValidationError } from "./util.ts";

const DAY_MS = 86_400_000;

/** Fewest decided drafts before approval rate / edit ratio are judged at all (capped by the criteria's own minimum). */
export const SHADOW_MIN_SAMPLE = 10;
/** The review backlog counts as "piling up" at this many pending drafts, or when the oldest has waited this long. */
export const SHADOW_PILING_COUNT = 10;
export const SHADOW_PILING_HOURS = 24;

/** Roles that draft outbound email (and so can be evaluated in a shadow run). */
const DRAFTING_ROLES = new Set(["sales-sdr", "account-manager"]);

// ---------------------------------------------------------------------------
// Start / end

/** Active shadow-tier agents that draft email — the default cast of a run. */
export function shadowCandidates(db: Db): ShadowStartCandidate[] {
  return db.agents
    .list()
    .filter((a) => a.status !== "archived" && a.trustTier === "shadow" && DRAFTING_ROLES.has(a.role))
    .map((a) => ({ agentId: a.id, displayName: a.displayName, role: a.role }));
}

export interface StartShadowRunInput {
  plannedDays?: number;
  agentIds?: string[];
  notes?: string;
}

/** Validate and start a run. Throws ValidationError (400) / ConflictError (409). */
export function startShadowRun(db: Db, input: StartShadowRunInput): ShadowRun {
  const active = db.shadowRuns.getActive();
  if (active) throw new ConflictError(`shadow run ${active.id} is already active (started ${active.startedAt}); end it first`);
  const agentIds = input.agentIds ?? shadowCandidates(db).map((c) => c.agentId);
  if (agentIds.length === 0) {
    throw new ValidationError("no shadow-tier agents to evaluate — create an SDR / Account Manager agent first (new agents start in shadow tier)");
  }
  for (const id of agentIds) {
    const agent = db.agents.get(id);
    if (!agent) throw new ValidationError(`unknown agent "${id}"`);
    if (agent.status === "archived") throw new ValidationError(`agent "${id}" is archived`);
    if (agent.trustTier !== "shadow") {
      throw new ValidationError(`agent "${id}" is in the ${agent.trustTier} tier; a shadow run only evaluates shadow-tier agents (drafts of other tiers can be sent)`);
    }
  }
  return db.shadowRuns.create({ plannedDays: input.plannedDays ?? DEFAULT_SHADOW_PLANNED_DAYS, agentIds, notes: input.notes ?? null });
}

// ---------------------------------------------------------------------------
// Verdict

export interface VerdictInput {
  criteria: PromotionCriteria;
  checks: CriterionCheck[];
  drafts: number;
  decided: number;
  /** Days of the run elapsed so far (fractional). */
  elapsedDays: number;
  plannedDays: number;
  /** A finished run is judged on what it collected (no projection). */
  ended: boolean;
}

const check = (checks: CriterionCheck[], code: CriterionCheck["code"]) => checks.find((c) => c.code === code)!;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One verdict per agent, on top of the scorecard's promotion criteria:
 *  - below_bar: a compliance rejection over the limit (any volume), or — once at least min(minDecided, 10) drafts are
 *    decided — approval rate under the minimum or median edit ratio over the maximum; lint error rate over the maximum
 *    once that many drafts exist.
 *  - not_enough_data: too few decisions to judge the rates, or the rates are fine but the pace of decisions will not
 *    reach minDecided by the end of the run.
 *  - on_track: rates meet the criteria on a big enough sample and minDecided is met (or projected by the planned end).
 */
export function shadowVerdict(i: VerdictInput): ShadowVerdict {
  const { criteria: c, checks } = i;
  const minSample = Math.max(1, Math.min(c.minDecided, SHADOW_MIN_SAMPLE));
  const compliance = check(checks, "compliance");
  const approval = check(checks, "approval_rate");
  const edit = check(checks, "edit_ratio");
  const lint = check(checks, "lint_rate");

  const below: string[] = [];
  if (compliance.status === "unmet") below.push(compliance.message!);
  if (i.decided >= minSample) {
    if (approval.status === "unmet") below.push(approval.message!);
    if (edit.status === "unmet") below.push(edit.message!);
  }
  if (i.drafts >= minSample && lint.status === "unmet") below.push(lint.message!);
  if (below.length > 0) return { status: "below_bar", reason: `${below.join("; ")} (${plural(i.decided, "decided draft")} so far)` };

  if (i.decided < minSample) {
    return {
      status: "not_enough_data",
      reason:
        i.drafts === 0
          ? "no drafts yet"
          : `${plural(i.decided, "decided draft")} so far — need at least ${minSample} before the rates mean anything`,
    };
  }

  const rates = [
    approval.value !== null ? `approval ${formatPct(approval.value)} (need ≥ ${formatPct(c.minApprovalRate)})` : null,
    edit.value !== null ? `median edit ${formatPct(edit.value)} (need ≤ ${formatPct(c.maxMedianEditRatio)})` : null,
    lint.value !== null ? `lint errors ${formatPct(lint.value)} (need ≤ ${formatPct(c.maxLintErrorsRate)})` : null,
  ].filter((x): x is string => x !== null);

  if (i.decided >= c.minDecided) {
    return { status: "on_track", reason: `meets every promotion criterion: ${rates.join(", ")}; ${i.decided}/${c.minDecided} decided` };
  }
  const projected = i.ended ? i.decided : Math.round((i.decided / Math.max(1, i.elapsedDays)) * i.plannedDays);
  if (projected >= c.minDecided) {
    return {
      status: "on_track",
      reason: `${rates.join(", ")}; ${i.decided}/${c.minDecided} decided, pace projects ~${projected} by day ${i.plannedDays}`,
    };
  }
  return {
    status: "not_enough_data",
    reason: i.ended
      ? `quality looks fine (${rates.join(", ")}) but only ${i.decided}/${c.minDecided} drafts were decided — extend the run or lower the minimum`
      : `quality looks fine (${rates.join(", ")}) but pace projects only ~${projected} decided by day ${i.plannedDays}, need ${c.minDecided} — review faster or extend the run`,
  };
}

// ---------------------------------------------------------------------------
// Status

function runWindow(run: ShadowRun, now: Date) {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now.getTime();
  const elapsedDays = Math.max(0, (end - start) / DAY_MS);
  return { start, end, elapsedDays, day: Math.floor(elapsedDays) + 1 };
}

/** Day index (1-based) of `at` inside the run, clamped to [1, lastDay]. */
function dayOf(at: string, startMs: number, lastDay: number): number {
  const d = Math.floor((Date.parse(at) - startMs) / DAY_MS) + 1;
  return Math.max(1, Math.min(lastDay, Number.isFinite(d) ? d : 1));
}

function emptyDaily(startMs: number, lastDay: number): ShadowDailyRow[] {
  return Array.from({ length: lastDay }, (_, k) => ({
    day: k + 1,
    startAt: new Date(startMs + k * DAY_MS).toISOString(),
    drafts: 0,
    approvedUnchanged: 0,
    approvedEdited: 0,
    rejected: 0,
  }));
}

/** An approved draft counts as edited when its body or subject differs from what the agent wrote. */
function wasEdited(item: OutboxItem, ratio: number): boolean {
  return ratio > 0 || (item.originalSubject ?? "") !== (item.subject ?? "");
}

interface Classified {
  /** Approved drafts with their edit flag/ratio. */
  approved: { item: OutboxItem; ratio: number; edited: boolean }[];
  rejected: OutboxItem[];
}

function classify(items: readonly OutboxItem[]): Classified {
  const s = summarizeDecisions(items);
  return {
    approved: s.approvedItems.map((item, k) => ({ item, ratio: s.ratios[k]!, edited: wasEdited(item, s.ratios[k]!) })),
    rejected: s.rejectedItems,
  };
}

function dailyRows(items: readonly OutboxItem[], startMs: number, lastDay: number): ShadowDailyRow[] {
  const rows = emptyDaily(startMs, lastDay);
  for (const i of items) rows[dayOf(i.createdAt, startMs, lastDay) - 1]!.drafts++;
  const { approved, rejected } = classify(items);
  for (const a of approved) {
    const at = a.item.decidedAt ?? a.item.updatedAt;
    rows[dayOf(at, startMs, lastDay) - 1]![a.edited ? "approvedEdited" : "approvedUnchanged"]++;
  }
  for (const r of rejected) rows[dayOf(r.decidedAt ?? r.updatedAt, startMs, lastDay) - 1]!.rejected++;
  return rows;
}

function sumDaily(perAgent: ShadowDailyRow[][], startMs: number, lastDay: number): ShadowDailyRow[] {
  const rows = emptyDaily(startMs, lastDay);
  for (const list of perAgent) {
    for (const r of list) {
      const t = rows[r.day - 1]!;
      t.drafts += r.drafts;
      t.approvedUnchanged += r.approvedUnchanged;
      t.approvedEdited += r.approvedEdited;
      t.rejected += r.rejected;
    }
  }
  return rows;
}

function agentStatus(db: Db, agent: Agent, run: ShadowRun, win: ReturnType<typeof runWindow>, criteria: PromotionCriteria, now: Date): ShadowAgentStatus {
  const lastDay = win.day;
  const until = run.endedAt ? new Date(run.endedAt) : undefined;
  const sc = computeScorecardWindow(db, agent, { since: new Date(run.startedAt), until, windowDays: Math.round(win.elapsedDays * 10) / 10 }, criteria);
  const inWindow = (at: string) => at >= run.startedAt && (!run.endedAt || at <= run.endedAt);
  const items = db.outbox.list({ agentId: agent.id }).filter((i) => inWindow(i.createdAt) && !isReplacedDraft(i));
  const { approved } = classify(items);

  const approvedEdited = approved.filter((a) => a.edited);
  const checks = checkCriteria(sc, criteria);
  const pendingItems = db.outbox.list({ agentId: agent.id, status: ["pending_approval"] }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lint = lintErrorStats(db, agent.id, items, inWindow, run.startedAt);
  const needsHuman = (
    db.sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM audit x JOIN tasks t ON t.id = x.task_id
         WHERE t.agent_id = ? AND x.kind = 'task.transition' AND x.at >= ? AND x.at <= ?
           AND json_extract(x.data, '$.to') = 'waiting_approval'`,
      )
      .get(agent.id, run.startedAt, run.endedAt ?? now.toISOString()) as { c: number }
  ).c;

  const base = {
    agentId: agent.id,
    displayName: agent.displayName,
    role: agent.role,
    trustTier: agent.trustTier,
    agentStatus: agent.status,
    drafts: sc.drafts,
    pending: pendingItems.length,
    oldestPendingAt: pendingItems[0]?.createdAt ?? null,
    decided: sc.decided,
    approvedUnchanged: approved.length - approvedEdited.length,
    approvedEdited: approvedEdited.length,
    medianEditRatioOfEdited: median(approvedEdited.map((a) => a.ratio)),
    medianEditRatio: sc.medianEditRatio,
    approvalRate: sc.approvalRate,
    rejected: sc.rejected,
    rejectionsByCategory: sc.rejectionsByCategory as Partial<Record<RejectionCategory, number>>,
    lintErrors: lint.errors,
    lintErrorRate: sc.lintErrorRate,
    needsHuman,
    medianReviewMinutes: sc.medianReviewMinutes,
    criteria: checks,
    promotionEligible: sc.promotion ? sc.promotion.eligible : null,
    daily: dailyRows(items, win.start, lastDay),
  };
  const verdict = shadowVerdict({
    criteria,
    checks,
    drafts: sc.drafts,
    decided: sc.decided,
    elapsedDays: win.elapsedDays,
    plannedDays: run.plannedDays,
    ended: run.endedAt !== null,
  });
  return { ...base, verdict };
}

export function computeShadowStatus(db: Db, run: ShadowRun, now: Date = new Date()): ShadowRunStatus {
  const win = runWindow(run, now);
  const criteria = loadCriteria(db);
  const agents = run.agentIds
    .map((id) => db.agents.get(id))
    .filter((a): a is Agent => a !== null)
    .map((a) => agentStatus(db, a, run, win, criteria, now));
  const pendingOldest = agents.map((a) => a.oldestPendingAt).filter((x): x is string => x !== null).sort()[0] ?? null;
  return {
    run,
    active: run.endedAt === null,
    day: win.day,
    plannedDays: run.plannedDays,
    daysRemaining: Math.max(0, Math.ceil(run.plannedDays - win.elapsedDays)),
    complete: win.elapsedDays >= run.plannedDays,
    endsAt: new Date(win.start + run.plannedDays * DAY_MS).toISOString(),
    asOf: now.toISOString(),
    criteria,
    agents,
    totals: {
      drafts: agents.reduce((n, a) => n + a.drafts, 0),
      approvedUnchanged: agents.reduce((n, a) => n + a.approvedUnchanged, 0),
      approvedEdited: agents.reduce((n, a) => n + a.approvedEdited, 0),
      rejected: agents.reduce((n, a) => n + a.rejected, 0),
      pending: agents.reduce((n, a) => n + a.pending, 0),
      oldestPendingAt: pendingOldest,
    },
    daily: sumDaily(agents.map((a) => a.daily), win.start, win.day),
  };
}

// ---------------------------------------------------------------------------
// Digest section

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The shadow-run block of the Chief of Staff's daily digest snapshot: null when no run is active.
 * `period` counts decisions made in [since, now] on drafts created during the run.
 */
export function buildShadowDigest(db: Db, since: Date, now: Date, status?: ShadowRunStatus | null): ShadowDigestSection | null {
  const run = db.shadowRuns.getActive();
  if (!run) return null;
  const st = status ?? computeShadowStatus(db, run, now);
  const sinceIso = since.toISOString();
  const nowIso = now.toISOString();
  const decidedIn = (at: string | null) => at !== null && at >= sinceIso && at <= nowIso;

  let draftsCreated = 0;
  let approvedUnchanged = 0;
  let approvedEdited = 0;
  let rejected = 0;
  const pending: OutboxItem[] = [];
  for (const id of run.agentIds) {
    const items = db.outbox.list({ agentId: id }).filter((i) => i.createdAt >= run.startedAt && !isReplacedDraft(i));
    draftsCreated += items.filter((i) => i.createdAt >= sinceIso && i.createdAt <= nowIso).length;
    const c = classify(items);
    for (const a of c.approved) if (decidedIn(a.item.decidedAt)) (a.edited ? approvedEdited++ : approvedUnchanged++);
    for (const r of c.rejected) if (decidedIn(r.decidedAt)) rejected++;
    pending.push(...db.outbox.list({ agentId: id, status: ["pending_approval"] }));
  }
  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const oldest = pending[0] ?? null;
  const ageHours = oldest ? Math.max(0, (now.getTime() - Date.parse(oldest.createdAt)) / 3_600_000) : 0;

  const brief = (s: string | null, max: number) => (s ? (s.length > max ? `${s.slice(0, max)}…` : s) : null);
  return {
    runId: run.id,
    startedAt: run.startedAt,
    plannedDays: run.plannedDays,
    day: st.day,
    daysRemaining: st.daysRemaining,
    complete: st.complete,
    period: { since: sinceIso, until: nowIso, draftsCreated, approvedUnchanged, approvedEdited, rejected },
    pendingDrafts: pending.length,
    oldestUnreviewed: oldest
      ? { outboxId: oldest.id, agentId: oldest.agentId, to: oldest.to, subject: brief(oldest.subject, 120), createdAt: oldest.createdAt, ageHours: round1(ageHours) }
      : null,
    pilingUp: pending.length >= SHADOW_PILING_COUNT || (oldest !== null && ageHours >= SHADOW_PILING_HOURS),
    agents: st.agents.map((a) => ({ agentId: a.agentId, displayName: a.displayName, verdict: a.verdict.status, reason: a.verdict.reason, decided: a.decided })),
    agentsBelowBar: st.agents.filter((a) => a.verdict.status === "below_bar").map((a) => ({ agentId: a.agentId, displayName: a.displayName, reason: a.verdict.reason })),
  };
}
