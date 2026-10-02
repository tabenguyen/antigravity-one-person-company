// Agent scorecards and promotion eligibility. Pure read-side computation over
// @agyhq/db (no new persistence).
//
// Definitions (all over the window [now - days, now], cohorted by the outbox
// item's createdAt, same as stats.ts):
//
//   drafts         every outbox item the agent created in the window (any status).
//   approved       items with status approved|held|sending|sent|failed AND a decidedBy
//                  (human "human:*" or policy "policy:autonomous"): "approved" is the
//                  decision; sending/sent/failed are just later lifecycle states of it.
//   rejected       status rejected AND decidedBy starts with "human:". Opt-out sweeps
//                  ("policy:opt-out") are not a verdict on draft quality and are excluded.
//   decided        approved + rejected.
//   approvalRate   approved / decided          (null when decided = 0)
//   editRatio      per approved item: wordAwareLevenshtein(originalBody, body) / max(len);
//                  0 = untouched, 1 = completely rewritten. medianEditRatio is the median
//                  over all approved items (unedited ones count as 0).
//   editedRate     fraction of approved items with editRatio > 0.
//   lintErrorRate  (drafts with any "error" finding + outbox.lint_blocked audit attempts)
//                  / (drafts + lint_blocked attempts)       (null when the denominator is 0)
//   medianReviewMinutes  createdAt -> decidedAt for human decisions (approve or reject).
//   replies        inbound events in the window classified "reply" that answer one of the
//                  agent's sent emails: matched by thread key, In-Reply-To/References
//                  Message-ID, or sender address after we emailed it.
//   replyRate      replies / sent, capped at 1 (null when sent = 0).
//   tasks          done / failed / needsHuman (= waiting_approval) of tasks created in the window.

import type {
  Agent,
  AgentScorecard,
  OutboxItem,
  PromotionCriteria,
  RejectionCategory,
  TrustTier,
} from "@agyhq/core";
import { DEFAULT_PROMOTION_CRITERIA } from "@agyhq/core";
import type { Db } from "@agyhq/db";

export const PROMOTION_CRITERIA_KEY = "promotion_criteria";

const APPROVED_STATUSES = new Set(["approved", "held", "sending", "sent", "failed"]);

// ---------------------------------------------------------------------------
// Edit distance

/** Cell budget for the exact char-level DP; beyond it we diff at word level. */
const CHAR_DP_MAX_CELLS = 4_000_000;

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  let n = a.length;
  let m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let x = a;
  let y = b;
  if (m > n) {
    // keep the inner (row) dimension the shorter one
    x = b;
    y = a;
    [n, m] = [m, n];
  }
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const xi = x[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = xi === y[j - 1] ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = cur[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m]!;
}

function distanceRatio<T>(a: readonly T[], b: readonly T[]): number {
  // Common prefix/suffix cost nothing and make the typical "light edit" case near-linear.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const denom = Math.max(a.length, b.length);
  if (denom === 0) return 0;
  return levenshtein(a.slice(start, endA), b.slice(start, endB)) / denom;
}

/**
 * Normalized edit distance in [0, 1] between two texts (whitespace-normalized).
 * Exact char-level Levenshtein (O(n*m), prefix/suffix trimmed first) when the
 * trimmed middle is within {@link CHAR_DP_MAX_CELLS} cells; otherwise a
 * word-level Levenshtein, which is O(words^2) and still bounded for bodies capped at 10k chars.
 */
export function editRatio(original: string, final: string): number {
  const a = original.replace(/\s+/g, " ").trim();
  const b = final.replace(/\s+/g, " ").trim();
  if (a === b) return 0;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const cells = (endA - start) * (endB - start);
  if (cells <= CHAR_DP_MAX_CELLS) return distanceRatio([...a], [...b]);
  return distanceRatio(a.split(" "), b.split(" "));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Criteria

export function loadCriteria(db: Db): PromotionCriteria {
  const stored = db.kv.get<Partial<PromotionCriteria>>(PROMOTION_CRITERIA_KEY);
  const merged: PromotionCriteria = { ...DEFAULT_PROMOTION_CRITERIA };
  if (stored && typeof stored === "object") {
    for (const key of Object.keys(DEFAULT_PROMOTION_CRITERIA) as (keyof PromotionCriteria)[]) {
      const v = stored[key];
      if (typeof v === "number" && Number.isFinite(v)) merged[key] = v;
    }
  }
  return merged;
}

export function saveCriteria(db: Db, patch: Partial<PromotionCriteria>): PromotionCriteria {
  const next = { ...loadCriteria(db), ...patch };
  db.kv.set(PROMOTION_CRITERIA_KEY, next);
  return next;
}

export function nextTier(tier: TrustTier): TrustTier | null {
  return tier === "shadow" ? "assisted" : tier === "assisted" ? "autonomous" : null;
}

function pct(x: number): string {
  const v = Math.round(x * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}

export function evaluatePromotion(
  sc: Pick<AgentScorecard, "decided" | "approvalRate" | "medianEditRatio" | "rejectionsByCategory" | "lintErrorRate">,
  c: PromotionCriteria,
): { eligible: boolean; unmet: string[] } {
  const unmet: string[] = [];
  if (sc.decided < c.minDecided) unmet.push(`decided drafts ${sc.decided} < ${c.minDecided}`);
  if (sc.approvalRate === null) unmet.push("approval rate n/a (no decisions yet)");
  else if (sc.approvalRate < c.minApprovalRate) unmet.push(`approval rate ${pct(sc.approvalRate)} < ${pct(c.minApprovalRate)}`);
  if (sc.medianEditRatio === null) unmet.push("median edit ratio n/a (no approved drafts yet)");
  else if (sc.medianEditRatio > c.maxMedianEditRatio) {
    unmet.push(`median edit ratio ${pct(sc.medianEditRatio)} > ${pct(c.maxMedianEditRatio)}`);
  }
  const compliance = sc.rejectionsByCategory.compliance ?? 0;
  if (compliance > c.maxComplianceRejections) unmet.push(`compliance rejections ${compliance} > ${c.maxComplianceRejections}`);
  if (sc.lintErrorRate !== null && sc.lintErrorRate > c.maxLintErrorsRate) {
    unmet.push(`lint error rate ${pct(sc.lintErrorRate)} > ${pct(c.maxLintErrorsRate)}`);
  }
  return { eligible: unmet.length === 0, unmet };
}

// ---------------------------------------------------------------------------
// Scorecard

const isHuman = (i: OutboxItem) => (i.decidedBy ?? "").startsWith("human:");

export function computeScorecard(
  db: Db,
  agent: Agent,
  days: number,
  criteria: PromotionCriteria = loadCriteria(db),
  now: Date = new Date(),
): AgentScorecard {
  const sinceIso = new Date(now.getTime() - days * 24 * 3_600_000).toISOString();
  const allItems = db.outbox.list({ agentId: agent.id });
  const items = allItems.filter((i) => i.createdAt >= sinceIso);

  const approvedItems = items.filter((i) => i.decidedBy !== null && APPROVED_STATUSES.has(i.status));
  const rejectedItems = items.filter((i) => i.status === "rejected" && isHuman(i));
  const approved = approvedItems.length;
  const rejected = rejectedItems.length;
  const decided = approved + rejected;
  const approvalRate = decided > 0 ? approved / decided : null;

  const ratios = approvedItems.map((i) => editRatio(i.originalBody, i.body));
  const editedRate = ratios.length > 0 ? ratios.filter((r) => r > 0).length / ratios.length : null;
  const medianEditRatio = median(ratios);

  const rejectionsByCategory: Partial<Record<RejectionCategory, number>> = {};
  for (const i of rejectedItems) {
    const cat = i.rejectionCategory ?? "other";
    rejectionsByCategory[cat] = (rejectionsByCategory[cat] ?? 0) + 1;
  }

  const lintBlocked = db.audit.list({ agentId: agent.id, kind: ["outbox.lint_blocked"], since: sinceIso }).length;
  const draftsWithErrors = items.filter((i) => i.lint.some((f) => f.severity === "error")).length;
  const lintDenom = items.length + lintBlocked;
  const lintErrorRate = lintDenom > 0 ? (draftsWithErrors + lintBlocked) / lintDenom : null;

  const reviewMinutes = items
    .filter((i) => isHuman(i) && i.decidedAt !== null)
    .map((i) => (Date.parse(i.decidedAt!) - Date.parse(i.createdAt)) / 60_000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  const medianReviewMinutes = median(reviewMinutes);

  // Replies to this agent's sent emails.
  const sentEver = allItems.filter((i) => i.status === "sent");
  const sent = items.filter((i) => i.status === "sent").length;
  const threadKeys = new Set(sentEver.map((i) => i.threadKey).filter((k): k is string => !!k));
  const messageIds = new Set(sentEver.map((i) => i.messageId).filter((m): m is string => !!m));
  const sentAtByAddress = new Map<string, string>();
  for (const i of sentEver) {
    const at = i.sentAt ?? i.updatedAt;
    const addr = i.to.toLowerCase();
    const prev = sentAtByAddress.get(addr);
    if (!prev || at < prev) sentAtByAddress.set(addr, at);
  }
  const replies = db.inbound
    .list({ classification: "reply" })
    .filter((e) => {
      if (e.receivedAt < sinceIso) return false;
      if (e.threadKey && threadKeys.has(e.threadKey)) return true;
      if (e.inReplyTo && messageIds.has(e.inReplyTo)) return true;
      if (e.references.some((r) => messageIds.has(r))) return true;
      const firstSent = e.fromAddress ? sentAtByAddress.get(e.fromAddress.toLowerCase()) : undefined;
      return firstSent !== undefined && firstSent <= e.receivedAt;
    }).length;
  const replyRate = sent > 0 ? Math.min(1, replies / sent) : null;

  const tasks = db.tasks.list({ agentId: agent.id }).filter((t) => t.createdAt >= sinceIso);
  const taskCounts = {
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    needsHuman: tasks.filter((t) => t.status === "waiting_approval").length,
  };

  const base = {
    agentId: agent.id,
    role: agent.role,
    trustTier: agent.trustTier,
    windowDays: days,
    drafts: items.length,
    decided,
    approved,
    rejected,
    approvalRate,
    editedRate,
    medianEditRatio,
    rejectionsByCategory,
    lintErrorRate,
    medianReviewMinutes,
    sent,
    replies,
    replyRate,
    tasks: taskCounts,
  };

  const next = nextTier(agent.trustTier);
  const promotion = next ? { nextTier: next, ...evaluatePromotion(base, criteria) } : null;
  return { ...base, promotion };
}
