// Types for agy `hooks.json` lifecycle hook I/O.
//
// Ported from spike/03-hooks/hook-types.ts and corrected against the
// OBSERVED payloads in spike/03-hooks/raw/*.jsonl (see spike/03-hooks/FINDINGS.md).
// Source of truth for the *documented* contract:
//   ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md
// Deviations from that doc, confirmed on the wire, are called out inline.
//
// All hook payload JSON uses protojson camelCase encoding.

// ---------------------------------------------------------------------------
// Common fields present on every hook stdin payload
// ---------------------------------------------------------------------------

export interface HookCommonFields {
  conversationId: string;
  workspacePaths: string[];
  /**
   * NDJSON transcript of the whole conversation, one JSON object per line.
   * Directory name is CLI-specific:
   *   .../brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
   * Always read the path the payload gives you, never hardcode it.
   */
  transcriptPath: string;
  artifactDirectoryPath: string;
  modelName: string;
}

/** One line of the NDJSON transcript at transcriptPath. */
export interface TranscriptLine {
  step_index: number;
  source: "USER_EXPLICIT" | "MODEL" | "SYSTEM" | "SYSTEM_SDK" | string;
  type: "USER_INPUT" | "PLANNER_RESPONSE" | "GENERIC" | "SYSTEM_MESSAGE" | "EPHEMERAL_MESSAGE" | string;
  status: "DONE" | string;
  created_at: string; // ISO-8601
  content?: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// 1. PreToolUse
// ---------------------------------------------------------------------------

export interface PreToolUseInput extends HookCommonFields {
  toolCall: {
    /** e.g. "run_command", "view_file", "list_dir", "call_mcp_tool" */
    name: string;
    /**
     * Shape is tool-specific. For call_mcp_tool, OBSERVED (spike 02):
     *   { ServerName: string, ToolName: string, Arguments: Record<string, unknown> }
     */
    args: Record<string, unknown>;
  };
  stepIdx: number;
}

export interface PreToolUseOutput {
  /** Required in practice: an omitted/invalid decision fails the hook. */
  decision: "allow" | "deny" | "ask" | "force_ask";
  /** Shown to the user AND fed back to the model verbatim on deny. */
  reason?: string;
  /** Temporary permission grants; not used by agy-hq (see spike 03 Q2). */
  permissionOverrides?: string[];
  /** Shallow top-level merge into toolCall.args before execution. */
  overwrite?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 2. PostToolUse
// ---------------------------------------------------------------------------

export interface PostToolUseInput extends HookCommonFields {
  stepIdx: number;
  /** "" (not absent) on success, observed. Non-empty if the tool failed. */
  error: string;
  toolCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

/**
 * Doc says "expects an empty JSON object {}" but any JSON object is
 * accepted. A PostToolUse hook can never undo the tool call (see
 * spike/03-hooks/FINDINGS.md Q5) — it is audit/cleanup only, never a gate.
 */
export type PostToolUseOutput = Record<string, unknown>;

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
   * Lands in the transcript as source: "SYSTEM_SDK", type: "EPHEMERAL_MESSAGE".
   * The model treats it as trusted context (verified in spike 03 Q3).
   */
  | { ephemeralMessage: string };

// ---------------------------------------------------------------------------
// 4. PostInvocation
// ---------------------------------------------------------------------------

export type PostInvocationInput = PreInvocationInput; // identical shape, confirmed by field overlap

export interface PostInvocationOutput {
  injectSteps?: InjectStep[];
  terminationBehavior?: "force_continue" | "terminate" | "";
}

// ---------------------------------------------------------------------------
// 5. Stop
// ---------------------------------------------------------------------------

export interface StopInput extends HookCommonFields {
  executionNum: number; // 0-based, increments each time the loop tries to stop
  /**
   * CORRECTED vs doc: the doc's example value is "model_stop"; every normal
   * stop observed in spike 03 reported "NO_TOOL_CALL" instead. Treat this
   * union as illustrative, not exhaustive.
   */
  terminationReason: "NO_TOOL_CALL" | "max_steps_exceeded" | "error" | string;
  /** Present (non-empty) if stopped due to error. */
  error: string;
  fullyIdle: boolean;
}

export interface StopOutput {
  /** Anything other than "continue" (including omitting the field) lets the agent stop. */
  decision?: "continue" | string;
  /**
   * Injected into the transcript as a SYSTEM/SYSTEM_MESSAGE line wrapped in
   * <SYSTEM_MESSAGE>, prefixed "Stop hook blocked termination: <reason>".
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Generic hook payload union used where a script only needs the common shape
// plus event-specific extras it may or may not trust.
// ---------------------------------------------------------------------------

export type AnyHookInput =
  | PreToolUseInput
  | PostToolUseInput
  | PreInvocationInput
  | PostInvocationInput
  | StopInput;
