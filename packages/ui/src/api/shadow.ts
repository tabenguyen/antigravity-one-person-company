// Shadow-run API (GET/POST /v1/admin/shadow). Wire types come from @agyhq/server (type-only, erased at build).

import type { ShadowRun } from "@agyhq/core";
import type {
  ShadowAgentStatus,
  ShadowDailyRow,
  ShadowOverview,
  ShadowRunStatus,
  ShadowStartCandidate,
  ShadowVerdictStatus,
  StartShadowRunRequest,
} from "@agyhq/server";
import { request } from "./client.ts";

export type { ShadowAgentStatus, ShadowDailyRow, ShadowOverview, ShadowRun, ShadowRunStatus, ShadowStartCandidate, ShadowVerdictStatus, StartShadowRunRequest };

export const shadowApi = {
  overview: () => request<ShadowOverview>("/v1/admin/shadow", { method: "GET" }),
  get: (id: string) => request<{ status: ShadowRunStatus }>(`/v1/admin/shadow/${encodeURIComponent(id)}`, { method: "GET" }),
  start: (body: StartShadowRunRequest = {}) => request<{ status: ShadowRunStatus }>("/v1/admin/shadow", { method: "POST", body: JSON.stringify(body) }),
  end: (id: string, body: { notes?: string } = {}) =>
    request<{ status: ShadowRunStatus }>(`/v1/admin/shadow/${encodeURIComponent(id)}/end`, { method: "POST", body: JSON.stringify(body) }),
};

export const VERDICT_LABEL: Record<ShadowVerdictStatus, string> = {
  on_track: "On track",
  not_enough_data: "Not enough data",
  below_bar: "Below bar",
};

export const VERDICT_PILL: Record<ShadowVerdictStatus, string> = {
  on_track: "pill-success",
  not_enough_data: "pill-neutral",
  below_bar: "pill-danger",
};
