import type { ReadinessCheck, ReadinessReport } from "../../../api/readiness.ts";
import type { SetupJob } from "../../../api/setupWizard.ts";

export type StepKey = "company" | "kb" | "email" | "sender" | "agent" | "golive";
export type StepStatus = "done" | "attention" | "todo";

export interface StepDef {
  key: StepKey;
  label: string;
  /** Readiness check ids that belong to this step. */
  checks: string[];
}

export const STEPS: StepDef[] = [
  { key: "company", label: "Công ty", checks: ["company.profile", "kb.company_present"] },
  { key: "kb", label: "Kiến thức bán hàng", checks: ["kb.no_placeholders"] },
  { key: "email", label: "Email", checks: ["email.provider", "email.verified"] },
  { key: "sender", label: "Người gửi", checks: ["sender.identity", "unsubscribe.mailto"] },
  { key: "agent", label: "Agent SDR", checks: ["agents.sdr_present", "settings.default_sdr"] },
  { key: "golive", label: "Go-live", checks: [] },
];

export const STATUS_LABEL: Record<StepStatus, string> = {
  done: "xong",
  attention: "cần xử lý",
  todo: "chưa làm",
};

export function isStepKey(v: string | null | undefined): v is StepKey {
  return !!v && STEPS.some((s) => s.key === v);
}

export function stepIndex(key: StepKey): number {
  return STEPS.findIndex((s) => s.key === key);
}

/** Where a failing readiness check should be fixed inside the wizard (null = not a wizard concern). */
export function stepForCheck(id: string): StepKey | null {
  for (const s of STEPS) if (s.checks.includes(id)) return s.key;
  return null;
}

export function stepPath(key: StepKey): string {
  return `/setup?step=${key}`;
}

/** Legacy fix links look like /setup#company or /setup#email. */
export function stepFromHash(hash: string): StepKey | null {
  const h = hash.replace(/^#/, "");
  if (isStepKey(h)) return h;
  return null;
}

function byId(report: ReadinessReport | null): Map<string, ReadinessCheck> {
  return new Map((report?.checks ?? []).map((c) => [c.id, c]));
}

export interface StatusContext {
  report: ReadinessReport | null;
  /** Latest generation job (any status) that has not necessarily been saved yet. */
  job: SetupJob | null;
  outboundEnabled: boolean;
}

/** Derives each step's dot from the readiness checks plus step-local data. */
export function computeStepStatuses(ctx: StatusContext): Record<StepKey, StepStatus | null> {
  const map = byId(ctx.report);
  const out = {} as Record<StepKey, StepStatus | null>;
  const stepChecks = (s: StepDef) => s.checks.map((id) => map.get(id)).filter((c): c is ReadinessCheck => !!c);

  for (const s of STEPS) {
    if (s.key === "golive") continue;
    const checks = stepChecks(s);
    if (!ctx.report || checks.length === 0) {
      out[s.key] = null; // unknown until readiness loads
      continue;
    }
    const failing = checks.filter((c) => c.status === "fail").length;
    out[s.key] = failing === 0 ? "done" : failing === checks.length ? "todo" : "attention";
  }

  // Step 1: an AI draft that has not been saved yet counts as "needs attention".
  if (out.company === "todo" && ctx.job && (ctx.job.status === "running" || (ctx.job.status === "done" && ctx.job.result))) {
    out.company = "attention";
  }
  // Step 2: placeholders only matter once the company profile exists.
  if (out.kb === "todo" && out.company === "done") out.kb = "attention";

  if (!ctx.report) out.golive = null;
  else if (ctx.outboundEnabled) out.golive = "done";
  else out.golive = ctx.report.ready ? "attention" : "todo";
  return out;
}
