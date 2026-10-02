#!/usr/bin/env node
// Stop hook — on success, maps the daemon's StopResponse to agy's Stop
// response (continue with reason / stop). On failure, falls back to a plain
// stop (never loop forever). Also guards against infinite continue loops
// independently of the daemon: after 2 forced continuations for a
// conversation, this hook stops unconditionally. See ../stop-state.ts for
// why both `executionNum` and a state file are consulted.

import { HOOK_ROUTES, type StopResponse } from "@agyhq/core";
import { readHookEnv } from "../env.ts";
import { postHook } from "../http.ts";
import { PLAIN_STOP_RESPONSE, toStopOutput, toStopRequest } from "../mapping.ts";
import { readHookPayload } from "../stdin.ts";
import { clearStopGuard, readStopGuardCount, writeStopGuardCount } from "../stop-state.ts";
import type { StopInput, StopOutput } from "../types.ts";

const TIMEOUT_MS = 5000;
const MAX_FORCED_CONTINUATIONS = 2;

async function run(): Promise<StopOutput> {
  const { payload } = await readHookPayload();
  const stopPayload = payload as unknown as StopInput | null;
  const conversationId = stopPayload?.conversationId ?? null;
  const cwd = process.cwd();

  const executionNum = typeof stopPayload?.executionNum === "number" ? stopPayload.executionNum : 0;
  const guardCount = Math.max(executionNum, readStopGuardCount(cwd, conversationId));

  if (guardCount >= MAX_FORCED_CONTINUATIONS) {
    clearStopGuard(cwd, conversationId);
    return PLAIN_STOP_RESPONSE;
  }

  const env = readHookEnv();
  if (!env) {
    clearStopGuard(cwd, conversationId);
    return PLAIN_STOP_RESPONSE;
  }

  const request = toStopRequest(stopPayload);

  try {
    const response = await postHook<StopResponse>(env, HOOK_ROUTES.stop, request, TIMEOUT_MS);
    const output = toStopOutput(response);
    if (output.decision === "continue") {
      writeStopGuardCount(cwd, conversationId, guardCount + 1);
    } else {
      clearStopGuard(cwd, conversationId);
    }
    return output;
  } catch {
    clearStopGuard(cwd, conversationId);
    return PLAIN_STOP_RESPONSE;
  }
}

run()
  .then((output) => process.stdout.write(JSON.stringify(output)))
  .catch(() => process.stdout.write(JSON.stringify(PLAIN_STOP_RESPONSE)));
