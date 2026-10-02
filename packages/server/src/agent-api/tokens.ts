// In-memory registry of per-task-run tokens. Distinct from @agyhq/db's
// AgentTokensRepo (one persisted long-lived token per agent): this is the
// short-lived credential the orchestrator mints right before spawning an agy
// process for one task run, passed to it as AGYHQ_TOKEN, and revokes the
// moment the run finishes. Never persisted; a daemon restart invalidates
// every outstanding run (which is fine — the orchestrator recovers stale
// "running" tasks on boot per @agyhq/db's `recoverStale`, and would re-issue
// a fresh token for whatever it requeues).

import { randomBytes } from "node:crypto";

export class RunTokenRegistry {
  #tokens = new Map<string, { agentId: string; taskId: string }>();

  /** Issue a fresh random 32-byte token bound to one (agentId, taskId) run. */
  issue(agentId: string, taskId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.#tokens.set(token, { agentId, taskId });
    return token;
  }

  /** Look up a presented token. Returns null for anything not currently issued. */
  verify(token: string): { agentId: string; taskId: string } | null {
    return this.#tokens.get(token) ?? null;
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }
}
