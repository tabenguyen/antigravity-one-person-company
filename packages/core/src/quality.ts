// Phase 3 shared types: readiness checks, company profile, draft lint, review
// categories, agent scorecards, routines and eval runs.

import type { AgentRole, Iso, TrustTier } from "./domain.ts";

// ---------------------------------------------------------------------------
// Readiness — "is it safe to turn outbound on?"

export type ReadinessStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  id: string; // stable, e.g. "kb.no_placeholders", "email.verified", "sender.identity"
  title: string;
  status: ReadinessStatus;
  detail: string; // what's wrong / what to do, human-readable
  /** UI route that fixes it, e.g. "/setup#company" or "/knowledge". */
  fixPath: string | null;
}

export interface ReadinessReport {
  /** true when no check is "fail". Enabling outbound requires this unless forced. */
  ready: boolean;
  checks: ReadinessCheck[];
  at: Iso;
}

/** Structured company facts; the daemon renders them into kb/company/*.md. */
export interface CompanyProfile {
  companyName: string;
  website: string | null;
  oneLiner: string; // what we sell, one sentence
  productDescription: string; // markdown
  targetCustomers: string; // ICP, markdown
  painPoints: string; // markdown bullet list
  differentiators: string; // markdown
  pricingPolicy: string; // what agents may say about price; markdown
  proofPoints: string; // case studies / numbers agents may cite; markdown
  forbiddenClaims: string; // things never to say; markdown
  meetingLink: string | null; // e.g. calendar booking URL
  languages: string[]; // e.g. ["vi","en"]
  updatedAt: Iso | null;
}

// ---------------------------------------------------------------------------
// Draft lint — deterministic checks run on every outbound draft

export type LintSeverity = "info" | "warn" | "error";

export interface LintFinding {
  code: string; // e.g. "placeholder", "unknown_price", "too_long", "no_cta", "language_mismatch"
  severity: LintSeverity;
  message: string;
}

/** Why a human rejected a draft — structured, for scorecards. */
export type RejectionCategory =
  | "factual_error"
  | "tone"
  | "too_long"
  | "not_personalized"
  | "wrong_recipient"
  | "bad_timing"
  | "compliance"
  | "other";

export const REJECTION_CATEGORIES: readonly RejectionCategory[] = [
  "factual_error",
  "tone",
  "too_long",
  "not_personalized",
  "wrong_recipient",
  "bad_timing",
  "compliance",
  "other",
];

// ---------------------------------------------------------------------------
// Scorecard & promotion

export interface PromotionCriteria {
  minDecided: number; // drafts decided by humans in the window
  minApprovalRate: number; // 0..1
  maxMedianEditRatio: number; // 0..1, normalized edit distance original→final for approved drafts
  maxComplianceRejections: number;
  maxLintErrorsRate: number; // fraction of drafts with any "error" lint finding
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  minDecided: 30,
  minApprovalRate: 0.85,
  maxMedianEditRatio: 0.15,
  maxComplianceRejections: 0,
  maxLintErrorsRate: 0.05,
};

export interface AgentScorecard {
  agentId: string;
  role: AgentRole;
  trustTier: TrustTier;
  windowDays: number;
  drafts: number;
  decided: number;
  approved: number; // approved + held
  rejected: number;
  approvalRate: number | null;
  editedRate: number | null; // approved drafts that were edited at all
  medianEditRatio: number | null;
  rejectionsByCategory: Partial<Record<RejectionCategory, number>>;
  lintErrorRate: number | null;
  medianReviewMinutes: number | null; // draft created → human decision
  sent: number;
  replies: number;
  replyRate: number | null; // replies / sent
  tasks: { done: number; failed: number; needsHuman: number };
  /** Next tier and whether criteria are met; null when already autonomous. */
  promotion: {
    nextTier: TrustTier;
    eligible: boolean;
    unmet: string[]; // human-readable reasons
  } | null;
}

// ---------------------------------------------------------------------------
// Routines — recurring work per agent

export type RoutineKind = "prospecting" | "pipeline_review" | "custom_task";

export interface Routine {
  id: string;
  agentId: string;
  kind: RoutineKind;
  name: string;
  /** 5-field cron, evaluated in `timezone`. */
  schedule: string;
  timezone: string;
  /**
   * prospecting: { batchSize, stages: LeadStage[] }  — research the next N uncontacted leads
   * pipeline_review: {}                              — daily summary task
   * custom_task: { kind, title, input }              — create this task each time
   */
  config: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: Iso | null;
  nextRunAt: Iso | null;
  lastResult: string | null; // short human-readable outcome
  createdAt: Iso;
  updatedAt: Iso;
}

// ---------------------------------------------------------------------------
// Evals — regression checks for role templates

export type EvalCaseStatus = "pass" | "fail" | "error" | "skipped";

export interface EvalCaseResult {
  caseId: string;
  status: EvalCaseStatus;
  durationMs: number;
  /** Assertion outcomes, e.g. "classification == unsubscribe". */
  assertions: { name: string; ok: boolean; detail?: string }[];
  output: unknown; // structured result / draft produced
}

export interface EvalRun {
  id: string;
  suite: string; // e.g. "sales-sdr"
  model: string;
  status: "running" | "done" | "failed";
  startedAt: Iso;
  finishedAt: Iso | null;
  results: EvalCaseResult[];
  summary: { total: number; pass: number; fail: number; error: number; skipped: number } | null;
}
