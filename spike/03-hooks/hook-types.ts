/**
 * TypeScript types for agy `hooks.json` lifecycle hook I/O, as OBSERVED in
 * Phase 0 spike #3 (agy-hq) against `agy` v1.2.14 (binary reports 1.2.14;
 * the PLAN.md spec sheet was written against 1.1.19 — contract appears
 * unchanged between those versions for everything tested here).
 *
 * Source of truth for the documented contract:
 *   ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md
 * This file adds the fields/behaviors that doc does not mention but that
 * were observed on the wire (see spike/03-hooks/raw/*.jsonl for captures).
 *
 * All hook payload JSON uses protojson camelCase encoding.
 */

// ---------------------------------------------------------------------------
// hooks.json file shape
// ---------------------------------------------------------------------------

export interface HooksConfigFile {
  /** Top-level key is an arbitrary hook-bundle name (e.g. "audit", "policy"). */
  [hookName: string]: HookSpec;
}

export interface HookSpec {
  /** Defaults to true. false disables every handler under this name. */
  enabled?: boolean;
  PreToolUse?: ToolMatcherGroup[];
  PostToolUse?: ToolMatcherGroup[];
  /** Flat list — matcher is ignored for these three event types. */
  PreInvocation?: HookHandler[];
  PostInvocation?: HookHandler[];
  Stop?: HookHandler[];
}

export interface ToolMatcherGroup {
  /**
   * Regex matched against the tool name. OBSERVED: matching is FULL-STRING
   * (anchored both ends), not substring search — matcher "command" does NOT
   * match tool name "run_command", but matcher "run_.*" DOES. "*" and ""
   * both mean match-everything (not literal regex "*", which would be
   * invalid regex on its own — agy special-cases it).
   */
  matcher: string;
  hooks: HookHandler[];
}

export interface HookHandler {
  /** Only "command" is implemented today. */
  type?: 'command';
  /** Shell command; run via `sh -c`. `~` expands. cwd = dir containing hooks.json. */
  command: string;
  /** Seconds. Default 30. OBSERVED: on timeout the hook process is SIGKILLed. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Common fields present on every hook stdin payload
// ---------------------------------------------------------------------------

export interface HookCommonFields {
  conversationId: string;
  workspacePaths: string[];
  /**
   * NDJSON transcript of the whole conversation, one JSON object per line.
   * Readable (and non-empty up to the current step) at every hook call,
   * including Stop. See `TranscriptLine` below for its shape.
   * Directory name is CLI-specific: `.../brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
   * for the `agy` CLI specifically (NOT `.gemini/antigravity-cli/transcript.jsonl`
   * as the generic doc example suggests — that path appears to be for a
   * different product surface; always read the path the payload gives you,
   * never hardcode it).
   */
  transcriptPath: string;
  artifactDirectoryPath: string;
  modelName: string;
}

/** One line of the NDJSON transcript at transcriptPath. */
export interface TranscriptLine {
  step_index: number;
  source: 'USER_EXPLICIT' | 'MODEL' | 'SYSTEM' | 'SYSTEM_SDK' | string;
  type:
    | 'USER_INPUT'
    | 'PLANNER_RESPONSE'
    | 'GENERIC'
    | 'SYSTEM_MESSAGE'
    | 'EPHEMERAL_MESSAGE'
    | string;
  status: 'DONE' | string;
  created_at: string; // ISO-8601
  content?: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// 1. PreToolUse
// ---------------------------------------------------------------------------

export interface PreToolUseInput extends HookCommonFields {
  toolCall: {
    name: string; // e.g. "run_command", "view_file", "list_dir", "call_mcp_tool"
    /**
     * Shape is tool-specific. OBSERVED for run_command:
     * { CommandLine, Cwd, IsDaemon, RunPersistent, WaitMsBeforeAsync,
     *   toolAction, toolSummary }
     * NOTE: "toolAction"/"toolSummary" are human-readable blurbs the model
     * generated for the UI, not semantic args — don't gate on them.
     */
    args: Record<string, unknown>;
  };
  stepIdx: number;
}

export interface PreToolUseOutput {
  /**
   * Required (if omitted, OBSERVED behavior was an invalid-output failure —
   * treat it as required in practice).
   */
  decision: 'allow' | 'deny' | 'ask' | 'force_ask';
  /** Shown to the user AND fed back to the model verbatim on deny. */
  reason?: string;
  /** Temporary permission grants; NOT independently verified in this spike. */
  permissionOverrides?: string[];
  /**
   * Shallow top-level merge into toolCall.args before execution. OBSERVED
   * working for run_command's CommandLine key.
   */
  overwrite?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 2. PostToolUse
// ---------------------------------------------------------------------------

export interface PostToolUseInput extends HookCommonFields {
  stepIdx: number;
  /** Present (non-empty string) if the tool failed. "" (not absent) on success, observed. */
  error: string;
  /** OBSERVED, not in the doc's minimal example: the full tool call is included too. */
  toolCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

/**
 * OBSERVED: the doc says "expects an empty JSON object {}" but any JSON
 * object is accepted; unknown keys appear to be ignored. A non-zero exit,
 * invalid JSON, or timeout from a PostToolUse hook does NOT undo the tool
 * call (it already ran and its real-world side effect already happened) —
 * it just flips that tool step's `state` to `ERROR` in the stream-json
 * output and surfaces the hook failure message to the model/user.
 */
export type PostToolUseOutput = Record<string, never> | Record<string, unknown>;

// ---------------------------------------------------------------------------
// 3. PreInvocation
// ---------------------------------------------------------------------------

export interface PreInvocationInput extends HookCommonFields {
  invocationNum: number; // 0-based, increments once per model call in the loop
  initialNumSteps: number;
}

export interface PreInvocationOutput {
  injectSteps?: InjectStep[];
}

export type InjectStep =
  | { toolCall: { name: string; args: Record<string, unknown> } }
  | { userMessage: string }
  /**
   * OBSERVED: lands in the transcript as a line with
   * source: "SYSTEM_SDK", type: "EPHEMERAL_MESSAGE", content: <text>.
   * The model treats it as trusted context and will cite it when asked
   * where a fact came from — verified with a "customer prefers
   * Vietnamese" injection the model could only have gotten from the hook.
   */
  | { ephemeralMessage: string };

// ---------------------------------------------------------------------------
// 4. PostInvocation
// ---------------------------------------------------------------------------

export type PostInvocationInput = PreInvocationInput; // identical shape, per doc; confirmed by field overlap

export interface PostInvocationOutput {
  injectSteps?: InjectStep[];
  terminationBehavior?: 'force_continue' | 'terminate' | '';
}

// ---------------------------------------------------------------------------
// 5. Stop
// ---------------------------------------------------------------------------

export interface StopInput extends HookCommonFields {
  executionNum: number; // 0-based, increments each time the loop tries to stop
  /**
   * OBSERVED values: "NO_TOOL_CALL" (model simply produced a final text
   * response with no further tool call) was the only value seen in this
   * spike's always-successful runs. The doc's example value "model_stop"
   * was NOT observed; treat the doc's enum as non-exhaustive / illustrative.
   */
  terminationReason: 'NO_TOOL_CALL' | 'max_steps_exceeded' | 'error' | string;
  /** Present (non-empty) if stopped due to error. */
  error: string;
  fullyIdle: boolean;
}

export interface StopOutput {
  /** Anything other than "continue" (including omitting the field) lets the agent stop. */
  decision?: 'continue' | string;
  /**
   * OBSERVED: injected into the transcript as a SYSTEM/SYSTEM_MESSAGE line
   * wrapped in a <SYSTEM_MESSAGE> tag, prefixed "Stop hook blocked
   * termination: <reason>". The model reliably acted on it (did what the
   * reason asked, then tried to stop again) across 2 forced continuations.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Failure-mode summary (see FINDINGS.md Q5 for full evidence)
// ---------------------------------------------------------------------------

/**
 * PreToolUse hook that times out, exits non-zero, prints invalid JSON, or
 * points at a missing script: in ALL four cases the tool call is BLOCKED
 * (fails closed) with a TOOL_ERROR surfaced to the model, e.g.:
 *   - timeout:      `JSON hook "..." failed: command failed: signal: killed`
 *   - non-zero exit: `JSON hook "..." failed: command failed: exit status 1`
 *   - invalid JSON:  `failed to unmarshal result from hook ... via protojson: ...`
 *   - missing script: same "command failed: exit status 1" shape, stderr has
 *                      the shell/node "command not found" / MODULE_NOT_FOUND text.
 *
 * PostToolUse hook failing the same four ways does NOT retroactively block
 * anything (the tool already ran) — it just marks that step ERROR and
 * reports the hook failure text. Treat PostToolUse as best-effort audit,
 * never as a gate.
 */
export type HookFailureMode = 'timeout' | 'nonzero_exit' | 'invalid_json' | 'missing_script';
