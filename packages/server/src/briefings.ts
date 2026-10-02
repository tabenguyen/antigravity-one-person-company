// Briefings: the Chief of Staff's daily digest, stored for the owner to read.
// The orchestrator calls storeBriefingFromTask() when a cos.daily_digest task
// finishes; keeping it here (db + audit + bus only) makes it testable without
// running agy.

import type { Briefing, Task, TaskResult } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { EventBus } from "./event-bus.ts";

export const DAILY_DIGEST_KIND = "cos.daily_digest";
export const MAX_BRIEFING_CHARS = 50_000;

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * When `task` is a cos.daily_digest that finished done with data.digestMarkdown, store a Briefing (once per task),
 * audit `briefing.created` and emit it. Returns the briefing, or null when there is nothing to store.
 */
export function storeBriefingFromTask(db: Db, bus: EventBus | undefined, task: Task, result: TaskResult): Briefing | null {
  if (task.kind !== DAILY_DIGEST_KIND || result.status !== "done") return null;
  const raw = result.data?.["digestMarkdown"];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const existing = db.briefings.getByTaskId(task.id);
  if (existing) return existing;

  const markdown = raw.trim().slice(0, MAX_BRIEFING_CHARS);
  const briefing = db.briefings.create({
    agentId: task.agentId,
    taskId: task.id,
    periodStart: isIso(task.input["periodStart"]) ? task.input["periodStart"] : task.createdAt,
    periodEnd: isIso(task.input["periodEnd"]) ? task.input["periodEnd"] : new Date().toISOString(),
    markdown,
  });
  db.audit.append({
    kind: "briefing.created",
    agentId: task.agentId,
    taskId: task.id,
    conversationId: null,
    data: { briefingId: briefing.id, chars: markdown.length },
  });
  bus?.emit("briefing.created", { briefingId: briefing.id, agentId: task.agentId, taskId: task.id });
  return briefing;
}
