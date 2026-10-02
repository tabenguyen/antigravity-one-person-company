#!/usr/bin/env node
// PreInvocation hook — FAIL-OPEN. Injects per-entity/task context fetched
// from the daemon as `injectSteps[].ephemeralMessage` (verified mechanism,
// spike/03-hooks/FINDINGS.md Q3). On any failure, injects nothing rather
// than blocking the model call.

import { HOOK_ROUTES, type ContextResponse } from "@agyhq/core";
import { readHookEnv } from "../env.ts";
import { postHook } from "../http.ts";
import { NO_CONTEXT_RESPONSE, toContextOutput, toContextRequest } from "../mapping.ts";
import { readHookPayload } from "../stdin.ts";
import type { PreInvocationOutput } from "../types.ts";

const TIMEOUT_MS = 3000;
const MAX_INJECTED_CHARS = 4000;

async function run(): Promise<PreInvocationOutput> {
  const env = readHookEnv();
  if (!env) return NO_CONTEXT_RESPONSE;

  const { payload } = await readHookPayload();
  const request = toContextRequest(payload);

  try {
    const response = await postHook<ContextResponse>(env, HOOK_ROUTES.context, request, TIMEOUT_MS);
    return toContextOutput(response, MAX_INJECTED_CHARS);
  } catch {
    return NO_CONTEXT_RESPONSE;
  }
}

run()
  .then((output) => process.stdout.write(JSON.stringify(output)))
  .catch(() => process.stdout.write(JSON.stringify(NO_CONTEXT_RESPONSE)));
