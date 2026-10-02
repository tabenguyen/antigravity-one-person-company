/**
 * AgyEvent types for `agy`'s `--output-format stream-json` NDJSON protocol,
 * plus a defensive line parser.
 *
 * Shapes verified against agy 1.2.14 — see spike/01-headless-io/FINDINGS.md
 * (Q1/Q5/Q6) and spike/01-headless-io/raw/*.txt for the captured transcripts
 * these were derived from. Ported and hardened from the spike seed code at
 * spike/01-headless-io/agy-events.ts.
 *
 * Known sharp edges (see FINDINGS.md for evidence):
 *  - There is no distinct top-level "error" event. Fatal/turn errors surface
 *    as (a) a non-JSON diagnostic line on STDERR, (b) a terminal "result"
 *    event with status "ERROR", or (c) plain "Error: ..." text on STDOUT
 *    with NO JSON and a non-zero exit code for pre-flight validation
 *    failures (bad flags/schema) — no "init" event is ever emitted for (c).
 *  - On `--print-timeout`, agy emits a "result" with status "SUCCESS", an
 *    empty response, and zero usage, and exits 0. The only signal a timeout
 *    actually happened is a stderr line containing "print timeout after ...
 *    returning partial output". Never trust status/exit code alone.
 *  - Denied tool calls do not fail the run: status stays "SUCCESS" with a
 *    non-empty "denied_actions" array. Always check it explicitly.
 *  - "conversation_id" placement is inconsistent: top-level on "init",
 *    nested one level down on "step_update"/"result". Use
 *    getConversationId() rather than reading it ad hoc.
 */

export type AgyStepState = "ACTIVE" | "DONE" | "ERROR";

export type AgyKnownStepType = "user_input" | "agent_response" | "tool" | "finish" | "system_message";

/** Raw usage shape as agy prints it (snake_case). Mapped to the core
 *  camelCase AgyUsage when building a RunResult — see run.ts mapUsage(). */
export interface RawAgyUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  [k: string]: unknown;
}

export interface AgyInitEvent {
  event: "init";
  /** Top-level on this event only — see module doc comment. */
  conversation_id: string;
  init: {
    model: string;
    cwd: string;
    /** Full built-in tool catalog, not the agent's active allowlist
     *  (FINDINGS.md #11) — don't use this for auditing. */
    tools: string[];
    permission_mode: string;
    json_schema?: unknown;
  };
}

interface AgyStepUpdateBase {
  conversation_id: string;
  step_index: number;
  state: AgyStepState;
  /** Known values are AgyKnownStepType; kept as `string` so a future step
   *  type agy adds doesn't break parsing. */
  step_type: string;
  duration_seconds?: number;
}

export interface AgyUserInputStep extends AgyStepUpdateBase {
  step_type: "user_input";
}

export interface AgyAgentResponseStep extends AgyStepUpdateBase {
  step_type: "agent_response";
  /** Incremental text chunk on ACTIVE lines; concatenate to reconstruct the
   *  full message. Present with final usage on the terminal DONE line. */
  text_delta?: string;
  usage?: RawAgyUsage;
}

export interface AgyToolInfo {
  name: string;
  /** Tool-specific argument bag — treat as opaque beyond what's parsed. */
  parameters: Record<string, unknown>;
  output?: unknown;
  /** Present when state is "ERROR" (denied permission, execution failure). */
  error?: {
    type: string;
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

/** Catch-all for a step_type this package doesn't model explicitly yet. */
export interface AgyGenericStep extends AgyStepUpdateBase {
  step_type: string;
}

export type AgyStepUpdate =
  | AgyUserInputStep
  | AgyAgentResponseStep
  | AgyToolStep
  | AgyFinishStep
  | AgySystemMessageStep
  | AgyGenericStep;

export interface AgyStepUpdateEvent {
  event: "step_update";
  step_update: AgyStepUpdate;
}

export type AgyRunStatus = "SUCCESS" | "ERROR";

export interface AgyDeniedAction {
  action: string; // e.g. "command", "write_file"
  display_name: string; // e.g. "RunCommand", "WriteToFile"
  [k: string]: unknown;
}

export interface AgyResult {
  conversation_id: string;
  status: AgyRunStatus;
  /** Final assistant text. Empty on a timed-out or fully-denied turn. */
  response: string;
  /** Present only when status is "ERROR". */
  error?: string;
  duration_seconds: number;
  num_turns: number;
  /** Present only when --json-schema was supplied and parsing succeeded.
   *  Keys are exactly the schema's declared properties. */
  structured_output?: Record<string, unknown>;
  json_schema?: unknown;
  usage: RawAgyUsage;
  /** Present when one or more tool calls were auto-denied. status is still
   *  "SUCCESS" in that case — always check this explicitly. */
  denied_actions?: AgyDeniedAction[];
}

export interface AgyResultEvent {
  event: "result";
  result: AgyResult;
}

/** Forward-compat catch-all for an "event" value this package doesn't know
 *  about yet (new agy event kind added in a later version). */
export interface AgyUnknownEvent {
  event: string;
  [k: string]: unknown;
}

/** Synthetic event produced by parseAgyLine() for a stdout line that was not
 *  valid JSON, or valid JSON missing a usable string "event" field. Surfaced
 *  through the event stream rather than thrown, so a pre-flight validation
 *  failure (plain "Error: ..." text, no "init" event — FINDINGS.md Q5) is
 *  visible to callers instead of silently dropped. */
export interface AgyParseErrorEvent {
  event: "parse_error";
  raw: string;
  error: string;
}

export type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | AgyParseErrorEvent | AgyUnknownEvent;

/** Returns the conversation id regardless of event kind, hiding the
 *  top-level-vs-nested inconsistency documented above. Returns null when the
 *  event carries no usable conversation id (parse errors, or an unknown
 *  event shape without one). */
export function getConversationId(ev: AgyEvent): string | null {
  // Explicit casts rather than a switch: AgyUnknownEvent's `event: string`
  // (needed so an unrecognized event kind still type-checks) makes this
  // union only loosely discriminated, so TS can't narrow a plain switch.
  if (ev.event === "init") {
    return (ev as AgyInitEvent).conversation_id;
  }
  if (ev.event === "step_update") {
    return (ev as AgyStepUpdateEvent).step_update.conversation_id ?? null;
  }
  if (ev.event === "result") {
    return (ev as AgyResultEvent).result.conversation_id ?? null;
  }
  if (ev.event === "parse_error") {
    return null;
  }
  const raw = (ev as AgyUnknownEvent).conversation_id;
  return typeof raw === "string" ? raw : null;
}

/**
 * Parses one line of agy's stdout in --output-format stream-json mode.
 *
 * Returns null for a blank line (nothing to report). Never throws: a line
 * that isn't valid JSON, or valid JSON without a string "event" field, comes
 * back as an AgyParseErrorEvent instead of crashing the caller. An "event"
 * value outside the known set (init/step_update/result) is preserved
 * verbatim as an AgyUnknownEvent rather than dropped, so a future agy
 * version that adds an event kind degrades gracefully.
 */
export function parseAgyLine(line: string): AgyEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { event: "parse_error", raw: trimmed, error: err instanceof Error ? err.message : String(err) };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { event: "parse_error", raw: trimmed, error: "not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.event !== "string") {
    return { event: "parse_error", raw: trimmed, error: "missing or non-string 'event' field" };
  }

  return parsed as AgyEvent;
}
