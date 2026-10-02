// Spawns `agy` for one task run and classifies the result.
//
// Invocation contract (docs/PHASE0.md D2, verified against agy 1.2.14 in
// spike/01-headless-io/FINDINGS.md Q2/Q3):
//
//   agy --print= --input-format stream-json --output-format stream-json \
//       --dangerously-skip-permissions [--agent <a>] [--model <m>] \
//       [--conversation <id>] [--json-schema <file>] --print-timeout <n>s
//
// then one stdin line `{"event":"user","message":{"role":"user","content":...}}`,
// then stdin is closed (one-shot task run, not a multi-turn session).
//
// Sharp edges this module exists to paper over (docs/PHASE0.md §2, FINDINGS.md):
//  #1 a `--print-timeout` cutoff reports status "SUCCESS" + exit 0 — the only
//     tell is a stderr line containing "print timeout after ... returning
//     partial output". We also run our own watchdog as defense in depth
//     against agy hanging anyway.
//  #2 denied tool calls also report status "SUCCESS" with a populated
//     "denied_actions" array — checked explicitly, never inferred from status.
//
// IMPORTANT: `--print-timeout 0` means "no timeout" (agy's own default) — we
// must never pass 0 through, or agy's internal timeout is effectively
// disabled and we'd rely solely on the (much coarser) hard watchdog.

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunResult, RunOutcome, AgyUsage as CoreAgyUsage } from "@agyhq/core";
import { parseAgyLine } from "./events.ts";
import type { AgyEvent, AgyInitEvent, AgyResultEvent, AgyResult, RawAgyUsage } from "./events.ts";
import { resolveAgyBin } from "./bin.ts";
import { getAgyVersion } from "./version.ts";

export interface RunOptions {
  /** Workspace directory agy runs in — determines which .agents/AGENTS.md
   *  and mcp_config.json are picked up (PLAN.md 3.1). */
  cwd: string;
  prompt: string;
  agent?: string;
  model?: string;
  /** Resume a specific conversation. Never rely on `--continue` (FINDINGS.md
   *  #9 — it resumes the globally most recent conversation, a race in a
   *  concurrent harness); always pass an explicit id tracked by the caller. */
  conversationId?: string;
  /** Written to a temp file and passed as `--json-schema <file>`; the file
   *  is removed once the run finishes, regardless of outcome. */
  jsonSchema?: object;
  /** Hard ceiling for this run. Also becomes agy's own `--print-timeout`
   *  (rounded up to whole seconds, floored at 1s so it's never literally 0 —
   *  see module doc comment). The Runner's own watchdog sends SIGTERM at
   *  timeoutMs + 15s and SIGKILL 5s after that, as defense in depth. */
  timeoutMs: number;
  /** Merged over process.env — this is how AGYHQ_* reach hooks and MCP. */
  env?: Record<string, string>;
  /** Defaults to the AGY_BIN env var, then "agy" resolved via PATH. */
  agyBin?: string;
  extraArgs?: string[];
  signal?: AbortSignal;
}

export interface RunHandle {
  events: AsyncIterable<AgyEvent>;
  /** Resolves once the process has exited and the result has been
   *  classified. Always resolves — never rejects — even on spawn failure. */
  result: Promise<RunResult>;
  kill(reason?: string): void;
  pid: number | undefined;
}

const PRINT_TIMEOUT_MARKER = "print timeout after";
const WATCHDOG_GRACE_MS = 15_000;
const WATCHDOG_KILL_MS = 5_000;
const STDERR_TAIL_BYTES = 4096;

/** Convenience wrapper around startRun() for callers that only need the
 *  final result, not the live event stream. */
export async function runAgy(opts: RunOptions): Promise<RunResult> {
  const handle = startRun(opts);
  // Drain the event stream so it never holds a consumer-less backlog if the
  // caller never touches handle.events.
  void (async () => {
    for await (const _ev of handle.events) {
      // no-op
    }
  })();
  return handle.result;
}

export function startRun(opts: RunOptions): RunHandle {
  const agyBin = resolveAgyBin(opts.agyBin);

  let schemaDir: string | null = null;
  let schemaFilePath: string | null = null;
  if (opts.jsonSchema) {
    schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-schema-"));
    schemaFilePath = path.join(schemaDir, "schema.json");
    fs.writeFileSync(schemaFilePath, JSON.stringify(opts.jsonSchema));
  }

  const args = buildArgs(opts, schemaFilePath);
  const env = { ...process.env, ...(opts.env ?? {}) };

  let child: ChildProcess;
  let spawnErrorMessage: string | null = null;
  try {
    child = spawn(agyBin, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    // Synchronous spawn failure (rare — usually spawn fails async via the
    // 'error' event instead). Resolve a fully-formed error result directly.
    cleanupSchemaDir(schemaDir);
    const message = err instanceof Error ? err.message : String(err);
    const result: RunResult = {
      outcome: "error",
      conversationId: opts.conversationId ?? null,
      text: "",
      structured: null,
      usage: null,
      deniedActions: [],
      exitCode: null,
      durationMs: 0,
      agyVersion: null,
      stderrTail: "",
      error: message,
    };
    return {
      events: (async function* () {})(),
      result: Promise.resolve(result),
      kill: () => {},
      pid: undefined,
    };
  }

  const queue = new AsyncQueue<AgyEvent>();
  const stderrTail = new TailBuffer(STDERR_TAIL_BYTES);

  let sawTimeoutMarker = false;
  let watchdogFired = false;
  let sawResultEvent = false;
  let lastResult: AgyResult | null = null;
  let initConversationId: string | null = null;
  let killedReason: string | null = null;
  let finalized = false;

  const startedAt = Date.now();

  // Send the prompt as one stdin line, then close stdin — one-shot task run
  // (docs/PHASE0.md D2). Wrapped defensively: the child may already have
  // exited (e.g. a bad flag) before we get here.
  try {
    const line = JSON.stringify({ event: "user", message: { role: "user", content: opts.prompt } });
    child.stdin?.write(line + "\n");
    child.stdin?.end();
  } catch {
    // 'error'/'close' handlers below cover this.
  }

  if (child.stdout) {
    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line: string) => {
      const ev = parseAgyLine(line);
      if (ev === null) return;
      if (ev.event === "init") {
        initConversationId = (ev as AgyInitEvent).conversation_id ?? null;
      } else if (ev.event === "result") {
        sawResultEvent = true;
        lastResult = (ev as AgyResultEvent).result;
      }
      queue.push(ev);
    });
  }

  if (child.stderr) {
    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line: string) => {
      stderrTail.push(line + "\n");
      if (line.includes(PRINT_TIMEOUT_MARKER)) sawTimeoutMarker = true;
    });
  }

  let sigtermTimer: NodeJS.Timeout | undefined;
  let sigkillTimer: NodeJS.Timeout | undefined;
  function clearWatchdogTimers() {
    if (sigtermTimer) clearTimeout(sigtermTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  }

  sigtermTimer = setTimeout(() => {
    watchdogFired = true;
    killedReason = killedReason ?? "watchdog timeout";
    safeKill(child, "SIGTERM");
    sigkillTimer = setTimeout(() => {
      safeKill(child, "SIGKILL");
    }, WATCHDOG_KILL_MS);
  }, opts.timeoutMs + WATCHDOG_GRACE_MS);

  let onAbort: (() => void) | undefined;
  if (opts.signal) {
    onAbort = () => kill("aborted");
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  let resolveResult!: (r: RunResult) => void;
  const resultPromise = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  function finalize(exitCode: number | null) {
    if (finalized) return;
    finalized = true;
    clearWatchdogTimers();
    if (opts.signal && onAbort) {
      try {
        opts.signal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
    }
    cleanupSchemaDir(schemaDir);
    queue.close();

    const durationMs = Date.now() - startedAt;
    const outcome = classifyOutcome({
      hasJsonSchema: Boolean(opts.jsonSchema),
      sawTimeoutMarker,
      watchdogFired,
      exitCode,
      spawnErrorMessage,
      lastResult,
      sawResultEvent,
    });

    const conversationId = lastResult?.conversation_id || initConversationId || opts.conversationId || null;
    const structuredRaw = lastResult?.structured_output ?? null;
    const structured = structuredRaw && typeof structuredRaw === "object" ? structuredRaw : (structuredRaw ?? null);
    const usage = lastResult ? mapUsage(lastResult.usage) : null;
    const errorMessage =
      spawnErrorMessage ?? (killedReason ? `killed: ${killedReason}` : (lastResult?.error ?? null));

    void getAgyVersion(agyBin).then((agyVersion) => {
      resolveResult({
        outcome,
        conversationId,
        text: lastResult?.response ?? "",
        structured,
        usage,
        deniedActions: lastResult?.denied_actions ?? [],
        exitCode,
        durationMs,
        agyVersion,
        stderrTail: stderrTail.toString(),
        error: errorMessage,
      });
    });
  }

  child.on("error", (err) => {
    spawnErrorMessage = err instanceof Error ? err.message : String(err);
  });
  child.on("close", (code) => {
    finalize(code);
  });

  function kill(reason?: string) {
    killedReason = killedReason ?? (reason ?? "killed");
    safeKill(child, "SIGTERM");
  }

  return {
    events: queue,
    result: resultPromise,
    kill,
    pid: child.pid,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildArgs(opts: RunOptions, schemaFilePath: string | null): string[] {
  const args: string[] = [
    // -p/--print is greedy (swallows the next argv token as prompt text even
    // if it looks like a flag) — pass an explicit empty value since the
    // actual prompt goes over stdin as a stream-json input line.
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ];
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.model) args.push("--model", opts.model);
  if (opts.conversationId) args.push("--conversation", opts.conversationId);
  if (schemaFilePath) args.push("--json-schema", schemaFilePath);

  // Never pass 0 — that means "no timeout" to agy (see module doc comment).
  const printTimeoutSec = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  args.push("--print-timeout", `${printTimeoutSec}s`);

  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

function cleanupSchemaDir(dir: string | null) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}

function mapUsage(u: RawAgyUsage): CoreAgyUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: u.total_tokens,
    thinkingTokens: u.thinking_tokens,
    cacheReadTokens: u.cache_read_tokens,
  };
}

interface ClassifyCtx {
  hasJsonSchema: boolean;
  sawTimeoutMarker: boolean;
  watchdogFired: boolean;
  exitCode: number | null;
  spawnErrorMessage: string | null;
  lastResult: AgyResult | null;
  sawResultEvent: boolean;
}

/** Order matters: timeout and denied are checked before generic error/empty
 *  classification because both can otherwise look like a bland success
 *  (status SUCCESS, exit 0, empty response) — see module doc comment. */
function classifyOutcome(ctx: ClassifyCtx): RunOutcome {
  if (ctx.sawTimeoutMarker || ctx.watchdogFired) return "timeout";

  const denied = ctx.lastResult?.denied_actions ?? [];
  if (denied.length > 0) return "denied";

  const nonZeroExit = ctx.exitCode !== null && ctx.exitCode !== 0;
  if (ctx.spawnErrorMessage || nonZeroExit || !ctx.sawResultEvent) return "error";

  const structured = ctx.lastResult?.structured_output ?? null;
  const hasStructured = structured !== null && typeof structured === "object";
  if (ctx.hasJsonSchema && !hasStructured) return "invalid_output";

  const text = ctx.lastResult?.response ?? "";
  if (!text && !hasStructured) return "empty";

  return "ok";
}

/** Keeps roughly the last `maxBytes` of appended text (UTF-16 code units,
 *  not exact bytes — good enough for a human-readable diagnostic tail). */
class TailBuffer {
  private buf = "";
  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.maxBytes * 4) {
      this.buf = this.buf.slice(-this.maxBytes * 2);
    }
  }

  toString(): string {
    return this.buf.length > this.maxBytes ? this.buf.slice(-this.maxBytes) : this.buf;
  }
}

/** Minimal single-consumer async queue: push() buffers events until a
 *  waiting next() call is ready to take them; close() ends iteration. Used
 *  to decouple "reading agy's stdout" (always happens, for result
 *  classification) from "a caller iterating handle.events" (optional). */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    let resolve = this.resolvers.shift();
    while (resolve) {
      resolve({ value: undefined as unknown as T, done: true });
      resolve = this.resolvers.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          // Guaranteed defined by the length check (noUncheckedIndexedAccess).
          const value = this.items.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
