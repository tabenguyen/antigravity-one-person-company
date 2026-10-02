// Fail-open spooling for the audit hook: when the daemon can't be reached,
// append the request to a local file so the daemon can ingest it later
// instead of silently dropping the event. Never throws — a broken spool
// must not turn a best-effort audit hook into a gate.

import fs from "node:fs";
import path from "node:path";
import type { AuditRequest } from "@agyhq/core";

export const AUDIT_SPOOL_RELATIVE_PATH = path.join(".agyhq", "audit-spool.jsonl");

export function auditSpoolPath(cwd: string): string {
  return path.join(cwd, AUDIT_SPOOL_RELATIVE_PATH);
}

export function spoolAuditRequest(cwd: string, request: AuditRequest, reason: string): void {
  try {
    const file = auditSpoolPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ spooledAt: new Date().toISOString(), reason, request });
    fs.appendFileSync(file, line + "\n");
  } catch {
    // Best-effort: swallow. The hook must still print its no-op response.
  }
}
