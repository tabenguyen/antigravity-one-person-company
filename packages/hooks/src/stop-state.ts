// Loop-guard state for the Stop hook.
//
// `StopInput.executionNum` counts "the loop tried to stop" attempts *within
// one agy process*. That's the right signal when the daemon forces
// continuation repeatedly inside a single run, but a resumed task
// (`--conversation <id>` across a fresh `agy` process, per docs/PHASE0.md D2)
// starts executionNum back at 0 — so a daemon that keeps saying "continue"
// across several separate task runs for the same conversation would never
// trip the executionNum-based guard. We persist a small per-conversation
// counter under `<cwd>/.agyhq/` as a backstop and take whichever count is
// higher. Never throws — a broken guard must fail toward stopping, not
// toward looping forever.

import fs from "node:fs";
import path from "node:path";

export function stopGuardPath(cwd: string, conversationId: string | null): string {
  const key = conversationId && conversationId.length > 0 ? conversationId : "unknown";
  return path.join(cwd, ".agyhq", `stop-guard-${key}.json`);
}

export function readStopGuardCount(cwd: string, conversationId: string | null): number {
  try {
    const raw = fs.readFileSync(stopGuardPath(cwd, conversationId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const count = (parsed as { count?: unknown } | null)?.count;
    return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

export function writeStopGuardCount(cwd: string, conversationId: string | null, count: number): void {
  try {
    const file = stopGuardPath(cwd, conversationId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ count }));
  } catch {
    // Best-effort only.
  }
}

export function clearStopGuard(cwd: string, conversationId: string | null): void {
  try {
    fs.rmSync(stopGuardPath(cwd, conversationId), { force: true });
  } catch {
    // Best-effort only.
  }
}
