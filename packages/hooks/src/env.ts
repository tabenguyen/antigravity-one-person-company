// Reads the AGYHQ_* env vars that agy-hq's runner sets on every `agy` child
// process (see docs/PHASE0.md D2). Hook processes inherit this env from agy.

import { ENV } from "@agyhq/core";

export interface HookEnv {
  apiUrl: string;
  token: string;
  agentId: string;
  taskId: string | null;
}

/**
 * Returns null if any REQUIRED var (apiUrl, token, agentId) is missing or
 * empty. taskId is optional per the contract in packages/core/src/api.ts.
 */
export function readHookEnv(env: NodeJS.ProcessEnv = process.env): HookEnv | null {
  const apiUrl = env[ENV.apiUrl];
  const token = env[ENV.token];
  const agentId = env[ENV.agentId];
  const taskId = env[ENV.taskId];
  if (!apiUrl || !token || !agentId) return null;
  return { apiUrl, token, agentId, taskId: taskId || null };
}
