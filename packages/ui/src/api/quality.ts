// Phase 3 quality API: rejection categories, relint, scorecards, promotion.
// Wire types come from @agyhq/core (type-only imports are erased at build).

import type { AgentScorecard, LintFinding, PromotionCriteria, RejectionCategory } from "@agyhq/core";
import { qs, request } from "./client.ts";
import type { Agent, OutboxItem, TrustTier } from "./types.ts";

export type { AgentScorecard, LintFinding, PromotionCriteria, RejectionCategory };

/** Display order and labels for rejection categories (mirrors core's REJECTION_CATEGORIES; kept local so the UI bundle does not pull in core at runtime). */
export const REJECTION_CATEGORY_OPTIONS: { value: RejectionCategory; label: string }[] = [
  { value: "factual_error", label: "Factual error" },
  { value: "tone", label: "Tone" },
  { value: "too_long", label: "Too long" },
  { value: "not_personalized", label: "Not personalized" },
  { value: "wrong_recipient", label: "Wrong recipient" },
  { value: "bad_timing", label: "Bad timing" },
  { value: "compliance", label: "Compliance" },
  { value: "other", label: "Other" },
];

export function categoryLabel(c: string): string {
  return REJECTION_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c;
}

export interface ScorecardsData {
  days: number;
  criteria: PromotionCriteria;
  scorecards: AgentScorecard[];
}

export const qualityApi = {
  scorecards: (days: number) => request<ScorecardsData>(`/v1/admin/scorecards${qs({ days })}`, { method: "GET" }),
  getCriteria: () => request<{ criteria: PromotionCriteria }>("/v1/admin/promotion-criteria", { method: "GET" }),
  putCriteria: (patch: Partial<PromotionCriteria>) =>
    request<{ criteria: PromotionCriteria }>("/v1/admin/promotion-criteria", { method: "PUT", body: JSON.stringify(patch) }),
  promoteAgent: (id: string, body: { force?: boolean; note?: string } = {}) =>
    request<{ agent: Agent }>(`/v1/admin/agents/${encodeURIComponent(id)}/promote`, { method: "POST", body: JSON.stringify(body) }),
  rejectWithCategory: (id: string, body: { reason: string; category: RejectionCategory; reviewer?: string }) =>
    request<{ item: OutboxItem }>(`/v1/admin/outbox/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify(body) }),
  relint: (id: string) => request<{ item: OutboxItem }>(`/v1/admin/outbox/${encodeURIComponent(id)}/relint`, { method: "POST" }),
};

export type { TrustTier };
