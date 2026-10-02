#!/usr/bin/env node
// Audit hook — best-effort, FAIL-OPEN. Used for both PostToolUse and
// PostInvocation (invoked as `node dist/audit.mjs PostToolUse` /
// `node dist/audit.mjs PostInvocation`, see the hooks.json contract in the
// package README). Per spike/03-hooks/FINDINGS.md Q5, PostToolUse can never
// retroactively block anything, so this hook must never fail the run: it
// always prints the no-op response, and on any failure to reach the daemon
// it spools the request to disk instead of dropping it.

import { HOOK_ROUTES, HookEvent, type AuditResponse } from "@agyhq/core";
import { readHookEnv } from "../env.ts";
import { HookRequestError, postHook } from "../http.ts";
import { AUDIT_NOOP_RESPONSE, toAuditRequest } from "../mapping.ts";
import { spoolAuditRequest } from "../spool.ts";
import { readHookPayload } from "../stdin.ts";

const TIMEOUT_MS = 2000;

function resolveEvent(arg: string | undefined): HookEvent {
  const parsed = HookEvent.safeParse(arg);
  return parsed.success ? parsed.data : "PostToolUse";
}

async function run(): Promise<void> {
  const event = resolveEvent(process.argv[2]);
  const { payload } = await readHookPayload();
  const request = toAuditRequest(event, payload);

  const env = readHookEnv();
  if (!env) {
    spoolAuditRequest(process.cwd(), request, "missing AGYHQ_API_URL/AGYHQ_TOKEN/AGYHQ_AGENT_ID");
  } else {
    try {
      await postHook<AuditResponse>(env, HOOK_ROUTES.audit, request, TIMEOUT_MS);
    } catch (e) {
      const detail = e instanceof HookRequestError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      spoolAuditRequest(process.cwd(), request, detail);
    }
  }
}

run()
  .catch(() => {
    // Swallow: audit must never fail the run.
  })
  .finally(() => {
    process.stdout.write(JSON.stringify(AUDIT_NOOP_RESPONSE));
  });
