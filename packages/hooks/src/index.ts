// @agyhq/hooks public API.
//
// The runnable artifacts are the bundled scripts in dist/ (built from
// src/bin/*.ts — see build.mjs and the package README for the hooks.json
// wiring contract). This module exports the pieces that are useful to
// import from TypeScript: payload/response types, the pure mapping
// functions, and the canonical script names/filenames.

export * from "./types.ts";
export * from "./mapping.ts";
export * from "./env.ts";
export { HookRequestError, postHook } from "./http.ts";
export type { HookRequestErrorCode } from "./http.ts";
export * from "./stdin.ts";
export { AUDIT_SPOOL_RELATIVE_PATH, auditSpoolPath, spoolAuditRequest } from "./spool.ts";
export { stopGuardPath, readStopGuardCount, writeStopGuardCount, clearStopGuard } from "./stop-state.ts";

/**
 * Canonical dist filenames, keyed by the agy lifecycle event(s) they serve.
 * Matches the hooks.json wiring contract exactly (docs/PLAN.md Phase 1 /
 * the task brief): PostToolUse and PostInvocation share the same `audit.mjs`
 * script, distinguished by an argv[2] of "PostToolUse" | "PostInvocation".
 */
export const HOOK_SCRIPT_NAMES = {
  PreToolUse: "pre-tool-use.mjs",
  PostToolUse: "audit.mjs",
  PreInvocation: "context.mjs",
  PostInvocation: "audit.mjs",
  Stop: "stop.mjs",
} as const satisfies Record<string, string>;

export type HookScriptNames = typeof HOOK_SCRIPT_NAMES;
