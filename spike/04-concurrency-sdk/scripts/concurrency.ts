// Phase 0 spike #4 (A) — concurrency/latency/quota/reliability harness for `agy`.
// Node 20 TypeScript/ESM, run via `npx tsx scripts/concurrency.ts`.
// Only touches ./runs/** inside this spike dir; never writes under ~/.gemini.

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SPIKE_DIR = path.resolve(new URL(".", import.meta.url).pathname, "..");
const RUNS_DIR = path.join(SPIKE_DIR, "runs");
const AGY_BIN = path.join(os.homedir(), ".local/bin/agy");
const GEMINI_LOG_DIR = path.join(os.homedir(), ".gemini/antigravity-cli/log");

interface RunResult {
  label: string;
  idx: number;
  cwd: string;
  cmd: string[];
  startedAt: string;
  wallMs: number;
  ttfbMs: number | null; // time to first stdout byte
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stderr: string;
  conversationId: string | null;
  status: string | null;
  durationSecondsReported: number | null;
  usage: unknown;
  parseError: string | null;
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Spawn one `agy -p ...` run in its own cwd, with a hard kill timeout as a safety net
 *  on top of agy's own --print-timeout (belt and suspenders — a hung process should
 *  never be able to wedge the harness). */
async function runOne(opts: {
  label: string;
  idx: number;
  prompt: string;
  model: string;
  printTimeout?: string;
  extraArgs?: string[];
  hardKillMs?: number;
}): Promise<RunResult> {
  const { label, idx, prompt, model, printTimeout = "2m", extraArgs = [], hardKillMs = 150_000 } = opts;
  const runDir = path.join(RUNS_DIR, `${label}-${idx}-${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    model,
    "--print-timeout",
    printTimeout,
    ...extraArgs,
  ];

  const startedAt = new Date().toISOString();
  const t0 = nowMs();
  let ttfbMs: number | null = null;
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn(AGY_BIN, args, { cwd: runDir, stdio: ["ignore", "pipe", "pipe"] });

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, hardKillMs);

  child.stdout.on("data", (chunk) => {
    if (ttfbMs === null) ttfbMs = nowMs() - t0;
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve) => {
      child.on("close", (code, sig) => resolve({ exitCode: code, signal: sig }));
    }
  );
  clearTimeout(killTimer);
  const wallMs = nowMs() - t0;

  await writeFile(path.join(runDir, "stdout.json"), stdout);
  await writeFile(path.join(runDir, "stderr.log"), stderr);

  let conversationId: string | null = null;
  let status: string | null = null;
  let durationSecondsReported: number | null = null;
  let usage: unknown = null;
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(stdout);
    conversationId = parsed.conversation_id ?? null;
    status = parsed.status ?? null;
    durationSecondsReported = parsed.duration_seconds ?? null;
    usage = parsed.usage ?? null;
  } catch (e) {
    parseError = (e as Error).message;
  }

  return {
    label,
    idx,
    cwd: runDir,
    cmd: [AGY_BIN, ...args],
    startedAt,
    wallMs,
    ttfbMs,
    exitCode,
    signal,
    timedOut,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stderr: stderr.slice(0, 4000),
    conversationId,
    status,
    durationSecondsReported,
    usage,
    parseError,
  };
}

async function runBatch(n: number, model: string, prompt: string, label: string) {
  const promises = Array.from({ length: n }, (_, i) => runOne({ label, idx: i, prompt, model }));
  return Promise.all(promises);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function tailLockAndLogSnapshot(label: string) {
  // Read-only snapshot of lock files / recent log lines around a batch, to spot
  // contention (lock wait errors, "database is locked", rate-limit text, etc).
  const snapshot: Record<string, unknown> = {};
  try {
    const presenceDir = path.join(os.homedir(), ".gemini/antigravity-cli/presence");
    snapshot.presenceLocks = (await readdir(presenceDir)).filter((f) => f.endsWith(".lock"));
  } catch (e) {
    snapshot.presenceLocksError = String(e);
  }
  try {
    const knowledgeLock = path.join(os.homedir(), ".gemini/antigravity-cli/knowledge/knowledge.lock");
    snapshot.knowledgeLockExists = existsSync(knowledgeLock);
  } catch (e) {
    snapshot.knowledgeLockError = String(e);
  }
  try {
    const files = (await readdir(GEMINI_LOG_DIR)).filter((f) => f.endsWith(".log")).sort();
    const latest = files[files.length - 1];
    if (latest) {
      const content = await readFile(path.join(GEMINI_LOG_DIR, latest), "utf8");
      const lines = content.split("\n");
      const interesting = lines.filter((l) =>
        /lock|rate.?limit|quota|exceed|429|resource_exhausted|busy|contention/i.test(l)
      );
      snapshot.latestLogFile = latest;
      snapshot.latestLogTailLines = lines.slice(-20);
      snapshot.interestingLines = interesting.slice(-40);
    }
  } catch (e) {
    snapshot.logReadError = String(e);
  }
  return { label, ...snapshot };
}

async function main() {
  await mkdir(RUNS_DIR, { recursive: true });
  const results: RunResult[] = [];
  const lockSnapshots: unknown[] = [];

  const PROMPT = "Reply with exactly the word: pong";

  console.error("=== Cold-start single run (gemini-3.8-flash-low, empty-ish prompt) ===");
  const cold = await runOne({ label: "coldstart", idx: 0, prompt: "hi", model: "gemini-3.8-flash-low" });
  results.push(cold);
  console.error(`cold-start wall=${cold.wallMs}ms exit=${cold.exitCode}`);

  for (const n of [1, 3, 5]) {
    const label = `n${n}`;
    console.error(`=== Running N=${n} parallel (gemini-3.8-flash-low) ===`);
    lockSnapshots.push(await tailLockAndLogSnapshot(`${label}-before`));
    const batch = await runBatch(n, "gemini-3.8-flash-low", PROMPT, label);
    results.push(...batch);
    lockSnapshots.push(await tailLockAndLogSnapshot(`${label}-after`));
    const ids = batch.map((r) => r.conversationId);
    const uniqueIds = new Set(ids.filter(Boolean));
    console.error(
      `N=${n}: exits=${batch.map((r) => r.exitCode).join(",")} ` +
        `wallMs=${batch.map((r) => r.wallMs).join(",")} ` +
        `uniqueConversationIds=${uniqueIds.size}/${batch.length}`
    );
  }

  console.error("=== Cross-model parallel run (1x gemini-3.8-flash-low, 1x claude-sonnet-4-6) ===");
  const crossModel = await Promise.all([
    runOne({ label: "cross-gemini", idx: 0, prompt: PROMPT, model: "gemini-3.8-flash-low" }),
    runOne({ label: "cross-claude", idx: 0, prompt: PROMPT, model: "claude-sonnet-4-6" }),
  ]);
  results.push(...crossModel);
  console.error(
    `cross-model exits=${crossModel.map((r) => r.exitCode).join(",")} ` +
      `wallMs=${crossModel.map((r) => r.wallMs).join(",")}`
  );

  // Quota visibility probes (slash commands via -p). Cheap: these don't seem to
  // consume a normal model turn (duration_seconds=0, usage all-zero).
  console.error("=== Quota visibility probes (/usage, /credits) ===");
  const usageProbe = await runOne({ label: "probe-usage", idx: 0, prompt: "/usage", model: "gemini-3.8-flash-low" });
  const creditsProbe = await runOne({
    label: "probe-credits",
    idx: 0,
    prompt: "/credits",
    model: "gemini-3.8-flash-low",
  });
  results.push(usageProbe, creditsProbe);

  // Build summary stats per N.
  const summary: Record<string, unknown> = {};
  for (const n of [1, 3, 5]) {
    const batch = results.filter((r) => r.label === `n${n}`);
    const walls = batch.map((r) => r.wallMs);
    const ttfbs = batch.map((r) => r.ttfbMs ?? r.wallMs);
    const failures = batch.filter((r) => r.exitCode !== 0 || r.status !== "SUCCESS");
    summary[`n${n}`] = {
      count: batch.length,
      wall_p50_ms: percentile(walls, 50),
      wall_p95_ms: percentile(walls, 95),
      ttfb_p50_ms: percentile(ttfbs, 50),
      ttfb_p95_ms: percentile(ttfbs, 95),
      failure_rate: failures.length / batch.length,
      unique_conversation_ids: new Set(batch.map((r) => r.conversationId).filter(Boolean)).size,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    agyBinary: AGY_BIN,
    notes:
      "N=1,3,5 batches use --output-format json so ttfbMs ~= wallMs (json mode emits one blob at EOF); see FINDINGS.md for a stream-json TTFB note.",
    results,
    lockSnapshots,
    coldStart: { wallMs: cold.wallMs, exitCode: cold.exitCode },
    crossModel,
    quotaProbes: { usageProbe, creditsProbe },
    summary,
  };

  await writeFile(path.join(SPIKE_DIR, "results.json"), JSON.stringify(output, null, 2));
  console.error("Wrote results.json");
  console.error(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exitCode = 1;
});
