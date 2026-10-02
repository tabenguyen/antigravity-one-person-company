// Phase 3 routines & evals API. Wire types come from @agyhq/core (type-only imports are erased at build).

import type { EvalCaseResult, EvalRun, Routine, RoutineKind } from "@agyhq/core";
import { qs, request } from "./client.ts";

export type { EvalCaseResult, EvalRun, Routine, RoutineKind };

export interface RoutineInput {
  agentId: string;
  kind: RoutineKind;
  name: string;
  schedule: string;
  timezone: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export type RoutinePatch = Partial<Omit<RoutineInput, "agentId">>;

export interface EvalSuiteInfo {
  name: string;
  defaultModel: string | null;
  cases: { id: string; description: string; kind: string }[];
}

export interface StartEvalInput {
  suite: string;
  model?: string;
  caseIds?: string[];
}

export const routinesApi = {
  list: (agentId?: string) => request<{ routines: Routine[] }>(`/v1/admin/routines${qs({ agentId })}`, { method: "GET" }),
  create: (body: RoutineInput) => request<{ routine: Routine }>("/v1/admin/routines", { method: "POST", body: JSON.stringify(body) }),
  patch: (id: string, body: RoutinePatch) =>
    request<{ routine: Routine }>(`/v1/admin/routines/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: (id: string) => request<{ deleted: true }>(`/v1/admin/routines/${encodeURIComponent(id)}`, { method: "DELETE" }),
  run: (id: string) => request<{ routine: Routine }>(`/v1/admin/routines/${encodeURIComponent(id)}/run`, { method: "POST", body: "{}" }),

  evalSuites: () => request<{ suites: EvalSuiteInfo[] }>("/v1/admin/evals/suites", { method: "GET" }),
  listEvals: (params: { suite?: string; limit?: number } = {}) =>
    request<{ runs: EvalRun[] }>(`/v1/admin/evals${qs({ suite: params.suite, limit: params.limit })}`, { method: "GET" }),
  getEval: (id: string) => request<{ run: EvalRun }>(`/v1/admin/evals/${encodeURIComponent(id)}`, { method: "GET" }),
  startEval: (body: StartEvalInput) => request<{ run: EvalRun }>("/v1/admin/evals", { method: "POST", body: JSON.stringify(body) }),
};
