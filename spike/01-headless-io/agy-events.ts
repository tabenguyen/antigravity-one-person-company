/**
 * agy-events.ts
 *
 * TypeScript types for `agy`'s `--output-format stream-json` NDJSON event
 * stream, plus a small runAgy() wrapper around node:child_process, and a
 * demo that runs one prompt and prints parsed events.
 *
 * Verified against agy 1.2.14 (binary at ~/.local/bin/agy). See FINDINGS.md
 * for the experiments this was derived from and raw/ for captured transcripts.
 *
 * Design notes (see FINDINGS.md Q1/Q5/Q6 for evidence):
 *  - Every line on stdout in stream-json mode is one JSON object with a
 *    top-level "event" field. There is NO top-level event union member for
 *    "error" as its own event type — fatal/turn errors surface either:
 *      (a) as a non-JSON diagnostic line on STDERR (e.g. "[agy] print
 *          timeout..." or "jetski: ..."), or
 *      (b) inside the terminal "result" event as status: "ERROR" with an
 *          "error" string, or
 *      (c) as plain "Error: ..." / "error: ..." text on stdout with NO
 *          JSON and a non-zero exit code, for flag/schema validation
 *          failures that happen before the run starts (no "init" event is
 *          emitted in that case).
 *  - CRITICAL GOTCHA: on `--print-timeout`, agy prints a partial "result"
 *    event with status "SUCCESS" (not "ERROR"/"TIMEOUT"), empty response,
 *    and zero usage, AND exits 0. The only signals that a timeout occurred
 *    are the stderr line and/or empty response + zero total_tokens with a
 *    duration_seconds of 0. The wrapper below treats the stderr marker as
 *    the source of truth and attaches it to the returned event stream.
 *  - "conversation_id" placement is inconsistent across event kinds: on
 *    "init" it is a top-level sibling of "init"; on "step_update" and
 *    "result" it is nested one level down inside the "step_update"/"result"
 *    object. Always read it from the per-kind location (see helpers below).
 *  - Denied tool calls (no --dangerously-skip-permissions / insufficient
 *    --mode) do NOT hang and do NOT fail the run: the tool's step_update
 *    goes to state "ERROR" with tool_info.error, the run continues, and the
 *    final "result" still reports status "SUCCESS" plus a "denied_actions"
 *    array. Treat denied_actions as a first-class signal, not just status.
 */

// ---------------------------------------------------------------------------
// Usage / cost
// ---------------------------------------------------------------------------

export interface AgyUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  // No dollar-cost field was ever observed in 1.2.14 output (json, stream-json,
  // or text). If cost tracking is needed, compute it in the harness from
  // (model, usage) using a locally maintained price table.
}

// ---------------------------------------------------------------------------
// init event — first line emitted on every print-mode run that gets far
// enough to start (i.e. passed flag/schema validation).
// ---------------------------------------------------------------------------

export interface AgyInitEvent {
  event: "init";
  /** Top-level on this event only — see conversation_id placement note above. */
  conversation_id: string;
  init: {
    model: string;
    cwd: string;
    /** Full list of built-in tool names available to the agent this run. */
    tools: string[];
    /** Observed values: "always-proceed" (--dangerously-skip-permissions),
     *  "request-review" (default / --mode accept-edits or plan). */
    permission_mode: string;
  };
}

// ---------------------------------------------------------------------------
// step_update event — one per step in the turn's execution. step_index is a
// monotonically increasing integer scoped to the whole conversation (it keeps
// climbing across turns when re-using one process with --input-format
// stream-json). The SAME step_index appears twice for steps that have a
// lifecycle: once with state "ACTIVE" (started) and again with state "DONE"
// (or "ERROR") when it finishes. Steps with no meaningful "start" (e.g.
// user_input, finish) appear once, directly as "DONE".
// ---------------------------------------------------------------------------

export type AgyStepState = "ACTIVE" | "DONE" | "ERROR";

export type AgyStepType =
  | "user_input"
  | "agent_response"
  | "tool"
  | "finish"
  | "system_message"; // observed once, emitted by --mode plan's auto plan-ack

interface AgyStepUpdateBase {
  conversation_id: string;
  step_index: number;
  state: AgyStepState;
  step_type: AgyStepType;
  duration_seconds?: number;
}

export interface AgyUserInputStep extends AgyStepUpdateBase {
  step_type: "user_input";
}

export interface AgyAgentResponseStep extends AgyStepUpdateBase {
  step_type: "agent_response";
  /** Incremental text chunk. Concatenate all text_delta values for this
   *  step_index (ACTIVE lines) to reconstruct the full message; state DONE
   *  may carry a final (often whitespace-only, e.g. "\n") trailing delta. */
  text_delta?: string;
  /** Present on the terminal (DONE) line for this step. */
  usage?: AgyUsage;
}

export interface AgyToolInfo {
  name: string;
  /** Tool-specific argument bag; keys vary per tool (e.g. CommandLine for
   *  run_command, AbsolutePath for view_file, TargetFile for write_to_file).
   *  Treat as unknown/opaque beyond what you specifically parse. */
  parameters: Record<string, unknown>;
  /** Present once the tool finishes successfully. Shape is tool-specific;
   *  commonly a string (command stdout, or a short descriptive summary). */
  output?: unknown;
  /** Present when state is "ERROR" (denied permission, execution failure). */
  error?: {
    type: string; // observed: "TOOL_ERROR"
    message: string;
  };
}

export interface AgyToolStep extends AgyStepUpdateBase {
  step_type: "tool";
  tool_name: string;
  tool_info: AgyToolInfo;
}

export interface AgyFinishStep extends AgyStepUpdateBase {
  step_type: "finish";
}

export interface AgySystemMessageStep extends AgyStepUpdateBase {
  step_type: "system_message";
}

export type AgyStepUpdate =
  | AgyUserInputStep
  | AgyAgentResponseStep
  | AgyToolStep
  | AgyFinishStep
  | AgySystemMessageStep;

export interface AgyStepUpdateEvent {
  event: "step_update";
  step_update: AgyStepUpdate;
}

// ---------------------------------------------------------------------------
// result event — terminal event for a turn. In --input-format stream-json
// mode with multiple input lines, ONE result event is emitted per input
// line/turn (the process keeps running and accepts more lines after it).
// usage/num_turns in "result" are CUMULATIVE for the whole conversation,
// not just the latest turn.
// ---------------------------------------------------------------------------

export type AgyRunStatus = "SUCCESS" | "ERROR";

export interface AgyDeniedAction {
  action: string; // e.g. "command", "write_file"
  display_name: string; // e.g. "RunCommand", "WriteToFile"
}

export interface AgyResult {
  conversation_id: string;
  status: AgyRunStatus;
  /** Final assistant text. Empty string on a timed-out or fully-denied turn. */
  response: string;
  /** Present only when status is "ERROR". */
  error?: string;
  duration_seconds: number;
  num_turns: number;
  /** Present only when --json-schema was supplied and the model's output
   *  parsed against it. Keys are exactly the schema's declared properties
   *  (extra keys the model may have emitted alongside them are dropped
   *  here, though they can still appear inside the raw "response" string). */
  structured_output?: Record<string, unknown>;
  /** Echoes back the (parsed) schema that was supplied via --json-schema. */
  json_schema?: unknown;
  usage: AgyUsage;
  /** Present when one or more tool calls were auto-denied this run because
   *  permission mode disallowed them and no human could approve headlessly.
   *  IMPORTANT: status is still reported as "SUCCESS" when this is present
   *  and nothing else failed — always check denied_actions explicitly. */
  denied_actions?: AgyDeniedAction[];
}

export interface AgyResultEvent {
  event: "result";
  result: AgyResult;
}

// ---------------------------------------------------------------------------
// Full discriminated union
// ---------------------------------------------------------------------------

export type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

/** Returns the conversation id regardless of which event kind this is,
 *  hiding the top-level-vs-nested inconsistency documented above. */
export function getConversationId(ev: AgyEvent): string {
  switch (ev.event) {
    case "init":
      return ev.conversation_id;
    case "step_update":
      return ev.step_update.conversation_id;
    case "result":
      return ev.result.conversation_id;
  }
}

// ---------------------------------------------------------------------------
// --json-schema for structured turn results
// ---------------------------------------------------------------------------

export interface AgyJsonSchemaOption {
  /** Either a JSON Schema object (serialized inline) or a path to a .json
   *  schema file on disk — both are accepted verbatim by `--json-schema`. */
  schema?: Record<string, unknown>;
  schemaFilePath?: string;
}

// ---------------------------------------------------------------------------
// Input events for --input-format stream-json (one NDJSON line per turn,
// written to agy's stdin). Confirmed shape by trial/error against agy 1.2.14 —
// NOT the same shape as Claude Code's `{"type":"user",...}` convention.
// agy expects a top-level "event" field (matching its own output vocabulary)
// and a "message" object (not a bare string).
// ---------------------------------------------------------------------------

export interface AgyUserInputMessage {
  event: "user";
  message: {
    role: "user";
    content: string;
  };
}

// ---------------------------------------------------------------------------
// runAgy() — minimal child_process wrapper. No deps; Node 20+.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import * as readline from "node:readline";

export interface RunAgyOptions {
  /** Path to the agy binary. Defaults to "agy" (resolved via PATH). */
  agyPath?: string;
  /** Working directory agy should run in (determines which .agents/AGENTS.md
   *  and mcp_config.json get picked up — see PLAN.md section 3.1). */
  cwd: string;
  /** Initial prompt for a single-turn run. Omit this AND set
   *  inputTurns for a multi-turn stream-json session instead. */
  prompt?: string;
  /** For --input-format stream-json: one or more user turns to send in
   *  order, over a single long-lived process. */
  inputTurns?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  agent?: string;
  conversationId?: string;
  continueConversation?: boolean;
  project?: string;
  newProject?: boolean;
  mode?: "plan" | "accept-edits";
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  jsonSchema?: AgyJsonSchemaOption;
  /** Maps to --print-timeout, e.g. "120s", "2m". agy's own default is 0
   *  (no timeout) — always set one explicitly in the harness; see
   *  FINDINGS.md Q5 for why the result alone can't be trusted to detect it. */
  printTimeout?: string;
  /** Hard kill timeout enforced by this wrapper (milliseconds), independent
   *  of agy's own --print-timeout, as defense in depth against a hung
   *  child process. */
  killAfterMs?: number;
}

export interface RunAgyHandle {
  events: AsyncIterable<AgyEvent>;
  /** Resolves with the child's exit code once the process has exited. */
  exitCode: Promise<number | null>;
  /** Raw stderr lines captured so far (diagnostics like print-timeout or
   *  "jetski: ..." permission-denial notices land here, never on stdout). */
  stderrLines: string[];
}

function buildArgs(opts: RunAgyOptions): string[] {
  const args: string[] = [];
  const isStream = Boolean(opts.inputTurns && opts.inputTurns.length > 0);

  // NOTE: -p/--print is a greedy flag — it swallows the very next argv
  // token as the prompt text, even if that token is itself a flag like
  // --input-format. For stream-json input (no inline prompt), you MUST
  // pass --print='' explicitly rather than a bare --print. See
  // FINDINGS.md Q2 for the exact failure mode this works around.
  if (isStream) {
    args.push("--print=");
  } else {
    args.push("--print", opts.prompt ?? "");
  }

  if (isStream) {
    args.push("--input-format", "stream-json");
  }
  args.push("--output-format", "stream-json");

  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.conversationId) args.push("--conversation", opts.conversationId);
  if (opts.continueConversation) args.push("--continue");
  if (opts.project) args.push("--project", opts.project);
  if (opts.newProject) args.push("--new-project");
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.sandbox) args.push("--sandbox");
  if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (opts.printTimeout) args.push("--print-timeout", opts.printTimeout);
  if (opts.jsonSchema?.schema) {
    args.push("--json-schema", JSON.stringify(opts.jsonSchema.schema));
  } else if (opts.jsonSchema?.schemaFilePath) {
    args.push("--json-schema", opts.jsonSchema.schemaFilePath);
  }

  return args;
}

/**
 * Spawns `agy` headless and yields parsed AgyEvent objects as they arrive
 * on stdout (NDJSON, one object per line). For multi-turn sessions, write
 * opts.inputTurns to stdin as they're consumed; the caller gets one
 * "result" event per turn back through the same async iterable.
 */
export function runAgy(opts: RunAgyOptions): RunAgyHandle {
  const args = buildArgs(opts);
  const child = spawn(opts.agyPath ?? "agy", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrLines: string[] = [];
  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on("line", (line) => stderrLines.push(line));

  let killTimer: NodeJS.Timeout | undefined;
  if (opts.killAfterMs) {
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.killAfterMs);
  }

  const exitCode = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      resolve(code);
    });
  });

  // Feed multi-turn input, one JSON line per turn, then close stdin.
  if (opts.inputTurns && opts.inputTurns.length > 0) {
    for (const turnText of opts.inputTurns) {
      const msg: AgyUserInputMessage = {
        event: "user",
        message: { role: "user", content: turnText },
      };
      child.stdin.write(JSON.stringify(msg) + "\n");
    }
    child.stdin.end();
  }

  async function* eventIterable(): AsyncIterable<AgyEvent> {
    const rl = readline.createInterface({ input: child.stdout });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Non-JSON lines happen for pre-flight validation errors (bad
        // flags/schema) that exit before any "init" event — surface them
        // to the caller rather than silently dropping them.
        stderrLines.push(`[stdout:non-json] ${trimmed}`);
        continue;
      }
      yield parsed as AgyEvent;
    }
  }

  return { events: eventIterable(), exitCode, stderrLines };
}

// ---------------------------------------------------------------------------
// Demo: run one prompt in the current directory and print parsed events.
// Run with: npx tsx agy-events.ts   (or compile with tsc and run with node)
// ---------------------------------------------------------------------------

async function demo() {
  const handle = runAgy({
    cwd: process.cwd(),
    prompt:
      "List the files in this directory and then read README.md and tell me the marker string you found.",
    model: "gemini-3.8-flash-low",
    dangerouslySkipPermissions: true,
    printTimeout: "60s",
    killAfterMs: 90_000,
  });

  for await (const ev of handle.events) {
    if (ev.event === "init") {
      console.log(`[init] model=${ev.init.model} conv=${ev.conversation_id} tools=${ev.init.tools.length}`);
    } else if (ev.event === "step_update") {
      const su = ev.step_update;
      if (su.step_type === "tool") {
        const t = su as AgyToolStep;
        console.log(`[tool ${su.state}] ${t.tool_name} ${JSON.stringify(t.tool_info.parameters)}`);
        if (t.tool_info.error) console.log(`  -> ERROR: ${t.tool_info.error.message}`);
      } else if (su.step_type === "agent_response") {
        const a = su as AgyAgentResponseStep;
        if (a.text_delta) process.stdout.write(a.text_delta);
      } else {
        console.log(`[step ${su.state}] ${su.step_type} idx=${su.step_index}`);
      }
    } else if (ev.event === "result") {
      console.log("\n[result]", JSON.stringify(ev.result, null, 2));
    }
  }

  const code = await handle.exitCode;
  if (handle.stderrLines.length > 0) {
    console.log("--- stderr ---");
    for (const l of handle.stderrLines) console.log(l);
  }
  console.log(`exit code: ${code}`);
}

// Only run the demo when this file is executed directly (not imported).
if (require.main === module) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
