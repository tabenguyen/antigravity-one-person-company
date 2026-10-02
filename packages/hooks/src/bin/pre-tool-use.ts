#!/usr/bin/env node
// PreToolUse hook — FAIL-CLOSED. See docs/PHASE0.md D3/D5 and
// spike/03-hooks/FINDINGS.md Q2/Q5 for why: this is the only hook that can
// actually prevent an action, and agy's own `--dangerously-skip-permissions`
// does not weaken a `deny` from here.
//
// Deny on: missing env, unparsable stdin, network error, timeout, non-2xx,
// or an invalid response envelope. Never throw without printing a deny.

import { HOOK_ROUTES, type PolicyDecision } from "@agyhq/core";
import { readHookEnv } from "../env.ts";
import { HookRequestError, postHook } from "../http.ts";
import { denyPreToolUse, toPreToolUseOutput, toPreToolUseRequest } from "../mapping.ts";
import { readHookPayload } from "../stdin.ts";
import type { PreToolUseInput, PreToolUseOutput } from "../types.ts";

const TIMEOUT_MS = 5000;

async function run(): Promise<PreToolUseOutput> {
  const env = readHookEnv();
  if (!env) {
    return denyPreToolUse("agy-hq: hook misconfigured (missing AGYHQ_API_URL/AGYHQ_TOKEN/AGYHQ_AGENT_ID) — denying by default.");
  }

  const { payload, error } = await readHookPayload();
  if (!payload || error) {
    return denyPreToolUse(`agy-hq: could not read tool-use request (${error ?? "empty payload"}) — denying by default.`);
  }

  const request = toPreToolUseRequest(payload as unknown as PreToolUseInput);

  try {
    const decision = await postHook<PolicyDecision>(env, HOOK_ROUTES.preToolUse, request, TIMEOUT_MS);
    return toPreToolUseOutput(decision);
  } catch (e) {
    const detail = e instanceof HookRequestError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return denyPreToolUse(`agy-hq: policy check failed (${detail}) — denying by default.`);
  }
}

run()
  .then((output) => {
    process.stdout.write(JSON.stringify(output));
  })
  .catch((e) => {
    // Absolute last resort: never let an uncaught exception skip printing a decision.
    process.stdout.write(
      JSON.stringify(denyPreToolUse(`agy-hq: internal hook error (${e instanceof Error ? e.message : String(e)}) — denying by default.`)),
    );
  });
