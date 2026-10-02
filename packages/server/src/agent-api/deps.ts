import os from "node:os";
import path from "node:path";
import type { Agent } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { RunTokenRegistry } from "./tokens.ts";
import type { AgentApiDeps } from "./index.ts";

/** AgentApiDeps with every optional field defaulted, used internally by route handlers. */
export interface ResolvedDeps {
  db: Db;
  tokens: RunTokenRegistry;
  now: () => Date;
  outboxDailyLimit: number;
  emit: (type: string, data: Record<string, unknown>) => void;
  agyStateDir: string;
  attachmentsRoot: string | null;
  taskKindsFor: (agent: Agent) => readonly string[] | null;
}

export function resolveDeps(deps: AgentApiDeps): ResolvedDeps {
  return {
    db: deps.db,
    tokens: deps.tokens,
    now: deps.now ?? (() => new Date()),
    outboxDailyLimit: deps.outboxDailyLimit ?? 50,
    emit: deps.emit ?? (() => {}),
    agyStateDir: deps.agyStateDir ?? path.join(os.homedir(), ".gemini", "antigravity-cli"),
    attachmentsRoot: deps.attachmentsRoot ?? null,
    taskKindsFor: deps.taskKindsFor ?? (() => null),
  };
}
