import type { EvalCaseResult, EvalRun } from "../../api/routines.ts";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function statusLabel(status: EvalCaseResult["status"] | EvalRun["status"]): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "error":
      return "ERROR";
    case "skipped":
      return "SKIPPED";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Run failed";
  }
}

export function statusClass(status: EvalCaseResult["status"] | EvalRun["status"]): string {
  if (status === "pass" || status === "done") return "rt-ok";
  if (status === "fail" || status === "failed") return "rt-bad";
  if (status === "error") return "rt-warn";
  return "faint";
}
