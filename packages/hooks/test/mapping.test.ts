import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  denyPreToolUse,
  toAuditRequest,
  toContextOutput,
  toContextRequest,
  toPreToolUseOutput,
  toPreToolUseRequest,
  toStopOutput,
  toStopRequest,
} from "../src/mapping.ts";
import type { PreToolUseInput, StopInput } from "../src/types.ts";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as T;
}

describe("toPreToolUseRequest", () => {
  it("maps a real run_command payload (spike 03, raw/02-baseline-skip-perms)", () => {
    const payload = fixture<PreToolUseInput>("pre-tool-use.run-command.json");
    const req = toPreToolUseRequest(payload);
    expect(req).toEqual({
      conversationId: "72a9fbf5-41ee-4ce4-bfca-2078291eaf36",
      toolName: "run_command",
      parameters: {
        CommandLine: "echo hello-hooks-spike-2",
        Cwd: "/Users/nguyentam/Documents/Makini/agy-ui/spike/03-hooks",
        IsDaemon: false,
        RunPersistent: false,
        WaitMsBeforeAsync: 5000,
        toolAction: "Running echo command",
        toolSummary: "Run echo command",
      },
    });
  });

  it("maps a call_mcp_tool payload, preserving ServerName/ToolName/Arguments (spike 02 shape)", () => {
    const payload = fixture<PreToolUseInput>("pre-tool-use.call-mcp-tool.json");
    const req = toPreToolUseRequest(payload);
    expect(req.toolName).toBe("call_mcp_tool");
    expect(req.parameters).toEqual({
      ServerName: "company-mcp",
      ToolName: "kb_search",
      Arguments: { query: "refund policy" },
    });
  });

  it("defaults conversationId to null and parameters to {} when absent", () => {
    const req = toPreToolUseRequest({
      conversationId: null as unknown as string,
      toolCall: { name: "view_file", args: undefined as unknown as Record<string, unknown> },
    } as PreToolUseInput);
    expect(req.conversationId).toBeNull();
    expect(req.parameters).toEqual({});
  });
});

describe("toPreToolUseOutput / denyPreToolUse", () => {
  it("maps allow", () => {
    expect(toPreToolUseOutput({ decision: "allow" })).toEqual({ decision: "allow" });
  });

  it("maps deny with reason (matches the real deny fixture's intent)", () => {
    const payload = fixture<PreToolUseInput>("pre-tool-use.deny-rm.json");
    expect((payload.toolCall.args as { CommandLine: string }).CommandLine).toContain("rm -rf");
    expect(toPreToolUseOutput({ decision: "deny", reason: "blocked: rm -rf" })).toEqual({
      decision: "deny",
      reason: "blocked: rm -rf",
    });
  });

  it("maps allow+overwrite (matches the real overwrite fixture's shape)", () => {
    const payload = fixture<PreToolUseInput>("pre-tool-use.overwrite.json");
    expect(payload.toolCall.name).toBe("run_command");
    const out = toPreToolUseOutput({ decision: "allow", overwrite: { CommandLine: "echo OVERWRITTEN-BY-HOOK" } });
    expect(out).toEqual({ decision: "allow", overwrite: { CommandLine: "echo OVERWRITTEN-BY-HOOK" } });
  });

  it("denyPreToolUse always produces a decision:deny with the given reason", () => {
    expect(denyPreToolUse("because")).toEqual({ decision: "deny", reason: "because" });
  });
});

describe("toAuditRequest", () => {
  it("extracts conversationId from a real PostToolUse payload", () => {
    const payload = fixture<Record<string, unknown>>("post-tool-use.json");
    const req = toAuditRequest("PostToolUse", payload);
    expect(req.event).toBe("PostToolUse");
    expect(req.conversationId).toBe(payload["conversationId"]);
    expect(req.payload).toEqual(payload);
  });

  it("tolerates a null payload", () => {
    const req = toAuditRequest("PostInvocation", null);
    expect(req).toEqual({ event: "PostInvocation", conversationId: null, payload: {} });
  });
});

describe("toContextRequest / toContextOutput", () => {
  it("extracts conversationId from a real PreInvocation payload", () => {
    const payload = fixture<Record<string, unknown>>("pre-invocation.json");
    const req = toContextRequest(payload);
    expect(req.conversationId).toBe(payload["conversationId"]);
  });

  it("maps messages to injectSteps ephemeralMessage entries, preserving order", () => {
    const out = toContextOutput({ messages: ["first note", "second note"] });
    expect(out).toEqual({
      injectSteps: [{ ephemeralMessage: "first note" }, { ephemeralMessage: "second note" }],
    });
  });

  it("returns {} for an empty message list", () => {
    expect(toContextOutput({ messages: [] })).toEqual({});
  });

  it("caps total injected size and truncates the message that crosses the cap", () => {
    const out = toContextOutput({ messages: ["a".repeat(10), "b".repeat(10)] }, 15);
    expect(out.injectSteps).toHaveLength(2);
    const [first, second] = out.injectSteps!;
    expect((first as { ephemeralMessage: string }).ephemeralMessage).toBe("a".repeat(10));
    // 10 used, 5 remaining -> "bb" + "..." = 5 chars
    expect((second as { ephemeralMessage: string }).ephemeralMessage).toBe("bb...");
  });

  it("drops messages entirely once the cap is already reached", () => {
    const out = toContextOutput({ messages: ["a".repeat(15), "this should be dropped"] }, 15);
    expect(out.injectSteps).toHaveLength(1);
  });
});

describe("toStopRequest / toStopOutput", () => {
  it("maps a real Stop payload (executionNum 0, forced-continue scenario)", () => {
    const payload = fixture<StopInput>("stop.execution0.json");
    const req = toStopRequest(payload);
    expect(req.conversationId).toBe(payload.conversationId);
    expect(req.transcriptPath).toBe(payload.transcriptPath);
    expect(req.terminationReason).toBe("NO_TOOL_CALL");
  });

  it("maps a real Stop payload (executionNum 2, the final real stop)", () => {
    const payload = fixture<StopInput>("stop.execution2.json");
    expect(payload.executionNum).toBe(2);
  });

  it("tolerates a null payload", () => {
    const req = toStopRequest(null);
    expect(req).toEqual({ conversationId: null, transcriptPath: null, terminationReason: null, payload: {} });
  });

  it("maps a continue decision", () => {
    expect(toStopOutput({ decision: "continue", reason: "not done yet" })).toEqual({
      decision: "continue",
      reason: "not done yet",
    });
  });

  it("maps a stop decision to {}", () => {
    expect(toStopOutput({ decision: "stop" })).toEqual({});
  });
});
