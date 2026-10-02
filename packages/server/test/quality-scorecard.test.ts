import { describe, expect, it } from "vitest";
import { DEFAULT_PROMOTION_CRITERIA, type PromotionCriteria } from "@agyhq/core";
import { computeScorecard, editRatio, evaluatePromotion, loadCriteria, median, saveCriteria } from "../src/quality/scorecard.ts";
import { addAgent, seedDraft } from "./quality-helpers.ts";
import { openTestDb } from "./helpers.ts";

const A = "aaaaaaaaaa";

describe("editRatio", () => {
  it("is 0 for identical text (ignoring whitespace) and 1 for a full rewrite", () => {
    expect(editRatio("hello  world", "hello world\n")).toBe(0);
    expect(editRatio("abc", "xyz")).toBe(1);
    expect(editRatio("", "")).toBe(0);
  });

  it("is normalized Levenshtein over max length", () => {
    expect(editRatio("abcdefghij", "abcdefghiX")).toBeCloseTo(0.1);
    expect(editRatio(A, "aaaaabbbbb")).toBeCloseTo(0.5);
    expect(editRatio("kitten", "sitting")).toBeCloseTo(3 / 7);
    expect(editRatio("", "abcd")).toBe(1);
  });

  it("handles Vietnamese diacritics per character", () => {
    expect(editRatio("Chào anh Lan", "Chao anh Lan")).toBeCloseTo(1 / 12);
  });

  it("falls back to a word-level diff for very long, very different bodies", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `alpha${i}`).join(" ");
    const b = Array.from({ length: 2500 }, (_, i) => (i % 2 ? `alpha${i}` : `beta${i}`)).join(" ");
    const t = Date.now();
    const r = editRatio(a, b);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r).toBeCloseTo(0.5, 1);
  });

  it("stays cheap for a small edit inside a long body (prefix/suffix trimming)", () => {
    const base = "Dòng nội dung dài. ".repeat(500);
    expect(editRatio(base, base + "Cảm ơn.")).toBeGreaterThan(0);
    expect(editRatio(base, base.replace("nội", "NỘI"))).toBeLessThan(0.001);
  });
});

describe("median", () => {
  it("handles empty, odd and even lists", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

/**
 * Seeded window (14 days), sdr-01:
 *  - approved x4: sent, edit ratios 0, 0, 0.1, 0.5   -> median 0.05, editedRate 0.5
 *  - human rejections x4: factual_error, tone, compliance, (null -> other)
 *  - policy:opt-out rejection (excluded from decisions)
 *  - one pending draft carrying a stored lint error; 2 lint_blocked audit events
 *  - one item 30 days old (outside window)
 *  - review minutes 10..80 (median 45)
 *  - replies: thread match, In-Reply-To match, sender-address match = 3 (+3 non-matching/ignored)
 */
function seedWindow() {
  const db = openTestDb();
  const agent = addAgent(db, "sdr-01", "shadow");
  const id = agent.id;
  seedDraft(db, id, { status: "sent", to: "a@x.com", original: A, reviewMinutes: 10, threadKey: "contact:a@x.com", messageId: "<m-a>" });
  seedDraft(db, id, { status: "sent", to: "b@x.com", original: A, reviewMinutes: 20, messageId: "<m-b>" });
  seedDraft(db, id, { status: "sent", to: "c@x.com", original: "abcdefghij", final: "abcdefghiX", reviewMinutes: 30, messageId: "<m-c>" });
  seedDraft(db, id, { status: "sent", to: "d@x.com", original: A, final: "aaaaabbbbb", reviewMinutes: 40, messageId: "<m-d>" });
  seedDraft(db, id, { status: "rejected", category: "factual_error", reviewMinutes: 50, to: "e@x.com" });
  seedDraft(db, id, { status: "rejected", category: "tone", reviewMinutes: 60, to: "f@x.com" });
  seedDraft(db, id, { status: "rejected", category: "compliance", reviewMinutes: 70, to: "g@x.com" });
  seedDraft(db, id, { status: "rejected", reviewMinutes: 80, to: "h@x.com" });
  seedDraft(db, id, { status: "rejected", decidedBy: "policy:opt-out", category: "other", to: "i@x.com" });
  seedDraft(db, id, { status: "pending_approval", to: "j@x.com", lint: [{ code: "unknown_price", severity: "error", message: "x" }, { code: "no_cta", severity: "warn", message: "y" }] });
  seedDraft(db, id, { status: "sent", to: "old@x.com", daysAgo: 30, reviewMinutes: 5 });
  for (let i = 0; i < 2; i++) {
    db.audit.append({ kind: "outbox.lint_blocked", agentId: id, taskId: null, conversationId: null, data: { findings: [] } });
  }

  const inbound = (externalId: string, extra: Record<string, unknown>) =>
    db.inbound.insertIfNew({ source: "email", externalId, bodyText: "re", classification: "reply", ...extra } as never);
  inbound("r1", { fromAddress: "zzz@x.com", threadKey: "contact:a@x.com" }); // thread
  inbound("r2", { fromAddress: "yyy@x.com", inReplyTo: "<m-c>" }); // In-Reply-To
  inbound("r3", { fromAddress: "B@x.com" }); // from a recipient after we emailed them
  inbound("r4", { fromAddress: "nobody@x.com" }); // unrelated
  inbound("r5", { fromAddress: "d@x.com", classification: "unsubscribe" }); // not a reply
  inbound("r6", { fromAddress: "old@x.com", receivedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() }); // outside the 14-day window

  const mk = (status: "done" | "failed" | "waiting_approval") => {
    const t = db.tasks.create({ agentId: id, kind: "sdr.research_lead", title: status });
    db.tasks.transition(t.id, "running");
    db.tasks.transition(t.id, status);
  };
  mk("done");
  mk("done");
  mk("failed");
  mk("waiting_approval");
  return { db, agent };
}

describe("computeScorecard math", () => {
  it("counts, rates and medians over the window", () => {
    const { db, agent } = seedWindow();
    const sc = computeScorecard(db, agent, 14, DEFAULT_PROMOTION_CRITERIA);
    expect(sc.agentId).toBe("sdr-01");
    expect(sc.trustTier).toBe("shadow");
    expect(sc.windowDays).toBe(14);
    expect(sc.drafts).toBe(10); // 4 sent + 5 rejected + 1 pending; the 30-day-old one is outside
    expect(sc.approved).toBe(4);
    expect(sc.rejected).toBe(4); // policy:opt-out excluded
    expect(sc.decided).toBe(8);
    expect(sc.approvalRate).toBeCloseTo(0.5);
    expect(sc.editedRate).toBeCloseTo(0.5);
    expect(sc.medianEditRatio).toBeCloseTo(0.05);
    expect(sc.rejectionsByCategory).toEqual({ factual_error: 1, tone: 1, compliance: 1, other: 1 });
    expect(sc.lintErrorRate).toBeCloseTo((1 + 2) / (10 + 2));
    expect(sc.medianReviewMinutes).toBeCloseTo(45);
    expect(sc.sent).toBe(4);
    expect(sc.replies).toBe(3);
    expect(sc.replyRate).toBeCloseTo(0.75);
    expect(sc.tasks).toEqual({ done: 2, failed: 1, needsHuman: 1 });
  });

  it("a wider window includes older drafts", () => {
    const { db, agent } = seedWindow();
    const sc = computeScorecard(db, agent, 60, DEFAULT_PROMOTION_CRITERIA);
    expect(sc.drafts).toBe(11);
    expect(sc.approved).toBe(5);
    expect(sc.replies).toBe(4); // the 20-day-old reply to the 30-day-old send now counts
  });

  it("returns nulls (not NaN) for an agent with no activity", () => {
    const db = openTestDb();
    const agent = addAgent(db, "sdr-02", "assisted");
    const sc = computeScorecard(db, agent, 14, DEFAULT_PROMOTION_CRITERIA);
    expect(sc).toMatchObject({
      drafts: 0, decided: 0, approved: 0, rejected: 0, approvalRate: null, editedRate: null, medianEditRatio: null,
      lintErrorRate: null, medianReviewMinutes: null, sent: 0, replies: 0, replyRate: null,
    });
    expect(sc.promotion?.eligible).toBe(false);
  });

  it("counts held and approved-but-unsent drafts as approvals, and ignores sorting of rejection categories", () => {
    const db = openTestDb();
    const agent = addAgent(db, "sdr-03", "shadow");
    seedDraft(db, agent.id, { status: "held" });
    seedDraft(db, agent.id, { status: "approved", decidedBy: "policy:autonomous" });
    seedDraft(db, agent.id, { status: "rejected", category: "too_long" });
    const sc = computeScorecard(db, agent, 14);
    expect(sc.approved).toBe(2);
    expect(sc.rejected).toBe(1);
    expect(sc.approvalRate).toBeCloseTo(2 / 3);
    expect(sc.rejectionsByCategory).toEqual({ too_long: 1 });
  });
});

describe("promotion", () => {
  it("is ineligible with readable unmet reasons under the default criteria", () => {
    const { db, agent } = seedWindow();
    const sc = computeScorecard(db, agent, 14, DEFAULT_PROMOTION_CRITERIA);
    expect(sc.promotion).toEqual({
      nextTier: "assisted",
      eligible: false,
      unmet: [
        "decided drafts 8 < 30",
        "approval rate 50% < 85%",
        "compliance rejections 1 > 0",
        "lint error rate 25% > 5%",
      ],
    });
  });

  it("is eligible when every criterion is met", () => {
    const { db, agent } = seedWindow();
    const criteria: PromotionCriteria = { minDecided: 8, minApprovalRate: 0.5, maxMedianEditRatio: 0.05, maxComplianceRejections: 1, maxLintErrorsRate: 0.25 };
    const sc = computeScorecard(db, agent, 14, criteria);
    expect(sc.promotion).toEqual({ nextTier: "assisted", eligible: true, unmet: [] });
  });

  it("reports the edit-ratio criterion when too many edits", () => {
    const { db, agent } = seedWindow();
    const sc = computeScorecard(db, agent, 14, { ...DEFAULT_PROMOTION_CRITERIA, minDecided: 1, maxMedianEditRatio: 0.01, minApprovalRate: 0, maxComplianceRejections: 9, maxLintErrorsRate: 1 });
    expect(sc.promotion?.unmet).toEqual(["median edit ratio 5% > 1%"]);
  });

  it("walks shadow -> assisted -> autonomous -> null", () => {
    const db = openTestDb();
    expect(computeScorecard(db, addAgent(db, "a", "shadow"), 14).promotion?.nextTier).toBe("assisted");
    expect(computeScorecard(db, addAgent(db, "b", "assisted"), 14).promotion?.nextTier).toBe("autonomous");
    expect(computeScorecard(db, addAgent(db, "c", "autonomous"), 14).promotion).toBeNull();
  });

  it("evaluatePromotion treats missing metrics as unmet except lint rate", () => {
    const r = evaluatePromotion({ decided: 99, approvalRate: null, medianEditRatio: null, rejectionsByCategory: {}, lintErrorRate: null }, DEFAULT_PROMOTION_CRITERIA);
    expect(r.eligible).toBe(false);
    expect(r.unmet).toHaveLength(2);
  });
});

describe("criteria storage", () => {
  it("defaults, then merges the stored partial over the defaults", () => {
    const db = openTestDb();
    expect(loadCriteria(db)).toEqual(DEFAULT_PROMOTION_CRITERIA);
    saveCriteria(db, { minDecided: 5 });
    expect(loadCriteria(db)).toEqual({ ...DEFAULT_PROMOTION_CRITERIA, minDecided: 5 });
    db.kv.set("promotion_criteria", { minApprovalRate: 0.7, bogus: 1, maxLintErrorsRate: "x" });
    expect(loadCriteria(db)).toEqual({ ...DEFAULT_PROMOTION_CRITERIA, minApprovalRate: 0.7 });
  });
});
