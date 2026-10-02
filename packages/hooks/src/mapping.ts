// Pure mapping functions: agy hook stdin payload -> @agyhq/core request shape,
// and @agyhq/core response shape -> agy hook stdout response. No I/O here so
// these are unit-testable directly against the raw payload samples in
// spike/03-hooks/raw/.

import type {
  AuditRequest,
  ContextRequest,
  ContextResponse,
  HookEvent,
  PolicyDecision,
  PreToolUseRequest,
  StopRequest,
  StopResponse,
} from "@agyhq/core";
import type { PreInvocationOutput, PreToolUseInput, PreToolUseOutput, StopInput, StopOutput } from "./types.ts";

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

export function toPreToolUseRequest(payload: PreToolUseInput): PreToolUseRequest {
  return {
    conversationId: payload.conversationId ?? null,
    toolName: payload.toolCall?.name ?? "",
    parameters: payload.toolCall?.args ?? {},
  };
}

/** The deny response used for every fail-closed path (missing env, network error, timeout, etc). */
export function denyPreToolUse(reason: string): PreToolUseOutput {
  return { decision: "deny", reason };
}

export function toPreToolUseOutput(decision: PolicyDecision): PreToolUseOutput {
  switch (decision.decision) {
    case "deny":
      return { decision: "deny", reason: decision.reason };
    case "allow":
      return "overwrite" in decision && decision.overwrite ? { decision: "allow", overwrite: decision.overwrite } : { decision: "allow" };
  }
}

// ---------------------------------------------------------------------------
// Audit (PostToolUse / PostInvocation)
// ---------------------------------------------------------------------------

/** Audit is always a no-op reply to agy — it never gates. */
export const AUDIT_NOOP_RESPONSE: Record<string, never> = {};

export function toAuditRequest(event: HookEvent, payload: Record<string, unknown> | null): AuditRequest {
  const conversationId = typeof payload?.["conversationId"] === "string" ? (payload["conversationId"] as string) : null;
  return { event, conversationId, payload: payload ?? {} };
}

// ---------------------------------------------------------------------------
// Context (PreInvocation)
// ---------------------------------------------------------------------------

export function toContextRequest(payload: Record<string, unknown> | null): ContextRequest {
  const conversationId = typeof payload?.["conversationId"] === "string" ? (payload["conversationId"] as string) : null;
  return { conversationId };
}

/** No context to inject — used on any failure (fail-open). */
export const NO_CONTEXT_RESPONSE: PreInvocationOutput = {};

/**
 * Turns `{messages: string[]}` into agy's `injectSteps` shape, capping the
 * total injected character count at `maxChars`. Messages are included in
 * order; the message that would cross the cap is truncated to fit (with an
 * ellipsis) and no further messages are included after it.
 */
export function toContextOutput(response: ContextResponse, maxChars = 4000): PreInvocationOutput {
  const messages = response.messages ?? [];
  const injectSteps: PreInvocationOutput["injectSteps"] = [];
  let used = 0;
  for (const message of messages) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    let text = message;
    if (text.length > remaining) {
      const ellipsis = "...";
      const keep = Math.max(0, remaining - ellipsis.length);
      text = text.slice(0, keep) + ellipsis;
    }
    if (text.length === 0) break;
    injectSteps.push({ ephemeralMessage: text });
    used += text.length;
  }
  return injectSteps.length > 0 ? { injectSteps } : {};
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export function toStopRequest(payload: StopInput | null): StopRequest {
  return {
    conversationId: payload?.conversationId ?? null,
    transcriptPath: payload?.transcriptPath ?? null,
    terminationReason: payload?.terminationReason ?? null,
    payload: (payload as unknown as Record<string, unknown>) ?? {},
  };
}

/** Plain stop — used on failure and once the loop-guard trips. */
export const PLAIN_STOP_RESPONSE: StopOutput = {};

export function toStopOutput(response: StopResponse): StopOutput {
  if (response.decision === "continue") {
    return { decision: "continue", reason: response.reason };
  }
  return {};
}
