// Integration tests: spawn the BUILT dist/*.mjs scripts as real child
// processes (exactly how agy invokes them) against a local mock HTTP daemon.
// Run `npm run build` in this package before running these tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_ROUTES } from "@agyhq/core";
import { startMockDaemon, type MockDaemon } from "./mock-daemon.ts";
import { runHook, distPath } from "./spawn-hook.ts";

const DIST_SCRIPTS = ["pre-tool-use.mjs", "audit.mjs", "context.mjs", "stop.mjs"];

beforeAll(() => {
  for (const script of DIST_SCRIPTS) {
    if (!fs.existsSync(distPath(script))) {
      throw new Error(`${script} is missing from dist/ — run \`npm run build\` in packages/hooks first.`);
    }
  }
});

let daemon: MockDaemon;
let tmpCwd: string;

beforeEach(async () => {
  daemon = await startMockDaemon();
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-hooks-test-"));
});

afterEach(async () => {
  await daemon.close();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function baseEnv(apiUrl: string): Record<string, string> {
  return {
    AGYHQ_API_URL: apiUrl,
    AGYHQ_TOKEN: "test-token",
    AGYHQ_AGENT_ID: "sdr-01",
    AGYHQ_TASK_ID: "task-123",
  };
}

const runCommandPayload = (conversationId = "conv-1") =>
  JSON.stringify({
    conversationId,
    modelName: "gemini-3.8-flash-low",
    stepIdx: 1,
    toolCall: { name: "run_command", args: { CommandLine: "echo hi" } },
    transcriptPath: "/tmp/transcript.jsonl",
    workspacePaths: [tmpCwd],
  });

describe("pre-tool-use.mjs", () => {
  it("allows when the daemon allows", async () => {
    daemon.setHandler(HOOK_ROUTES.preToolUse, (body) => {
      expect(body).toMatchObject({ toolName: "run_command" });
      return { envelope: { ok: true, data: { decision: "allow" } } };
    });
    const result = await runHook("pre-tool-use.mjs", runCommandPayload(), baseEnv(daemon.url), [], tmpCwd);
    expect(result.json).toEqual({ decision: "allow" });
  });

  it("denies with the daemon's reason", async () => {
    daemon.setHandler(HOOK_ROUTES.preToolUse, () => ({
      envelope: { ok: true, data: { decision: "deny", reason: "money movement needs approval" } },
    }));
    const result = await runHook("pre-tool-use.mjs", runCommandPayload(), baseEnv(daemon.url), [], tmpCwd);
    expect(result.json).toEqual({ decision: "deny", reason: "money movement needs approval" });
  });

  it("allows with overwrite", async () => {
    daemon.setHandler(HOOK_ROUTES.preToolUse, () => ({
      envelope: { ok: true, data: { decision: "allow", overwrite: { CommandLine: "echo OVERWRITTEN" } } },
    }));
    const result = await runHook("pre-tool-use.mjs", runCommandPayload(), baseEnv(daemon.url), [], tmpCwd);
    expect(result.json).toEqual({ decision: "allow", overwrite: { CommandLine: "echo OVERWRITTEN" } });
  });

  it("denies when the daemon is down (connection refused)", async () => {
    const result = await runHook(
      "pre-tool-use.mjs",
      runCommandPayload(),
      baseEnv("http://127.0.0.1:1"), // nothing listens on port 1
      [],
      tmpCwd,
    );
    expect((result.json as { decision: string }).decision).toBe("deny");
    expect((result.json as { reason: string }).reason).toMatch(/denying by default/);
  });

  it("denies on timeout", async () => {
    daemon.setHandler(HOOK_ROUTES.preToolUse, () => "hang");
    const result = await runHook("pre-tool-use.mjs", runCommandPayload(), baseEnv(daemon.url), [], tmpCwd);
    expect((result.json as { decision: string }).decision).toBe("deny");
    expect((result.json as { reason: string }).reason).toMatch(/timeout/);
  }, 15000);

  it("denies on an invalid envelope", async () => {
    daemon.setHandler(HOOK_ROUTES.preToolUse, () => ({ envelope: { not: "an envelope" } as never }));
    const result = await runHook("pre-tool-use.mjs", runCommandPayload(), baseEnv(daemon.url), [], tmpCwd);
    expect((result.json as { decision: string }).decision).toBe("deny");
    expect((result.json as { reason: string }).reason).toMatch(/invalid_envelope/);
  });

  it("denies on a non-2xx status", async () => {
    daemon.setHandler(HOOK_ROUTES.preToolUse, () => ({ status: 500, envelope: { ok: true, data: { decision: "allow" } } }));
    const result = await runHook("pre-tool-use.mjs", runCommandPayload(), baseEnv(daemon.url), [], tmpCwd);
    expect((result.json as { decision: string }).decision).toBe("deny");
  });

  it("denies on unparsable stdin", async () => {
    const result = await runHook("pre-tool-use.mjs", "not json", baseEnv(daemon.url), [], tmpCwd);
    expect((result.json as { decision: string }).decision).toBe("deny");
  });

  it("denies when required env vars are missing", async () => {
    const result = await runHook("pre-tool-use.mjs", runCommandPayload(), {}, [], tmpCwd);
    expect((result.json as { decision: string }).decision).toBe("deny");
    expect(daemon.requests).toHaveLength(0);
  });
});

describe("audit.mjs", () => {
  const postToolUsePayload = JSON.stringify({
    conversationId: "conv-2",
    stepIdx: 1,
    error: "",
    toolCall: { name: "run_command", args: { CommandLine: "echo hi" } },
    transcriptPath: "/tmp/transcript.jsonl",
    workspacePaths: [tmpCwd],
    modelName: "gemini-3.8-flash-low",
  });

  it("posts the audit event and prints {} (PostToolUse)", async () => {
    const result = await runHook("audit.mjs", postToolUsePayload, baseEnv(daemon.url), ["PostToolUse"], tmpCwd);
    expect(result.json).toEqual({});
    expect(daemon.requests).toHaveLength(1);
    expect(daemon.requests[0]?.route).toBe(HOOK_ROUTES.audit);
    expect(daemon.requests[0]?.body).toMatchObject({ event: "PostToolUse", conversationId: "conv-2" });
  });

  it("posts the audit event and prints {} (PostInvocation)", async () => {
    const result = await runHook("audit.mjs", postToolUsePayload, baseEnv(daemon.url), ["PostInvocation"], tmpCwd);
    expect(result.json).toEqual({});
    expect(daemon.requests[0]?.body).toMatchObject({ event: "PostInvocation" });
  });

  it("spools the request and still prints {} when the daemon is unreachable", async () => {
    const result = await runHook("audit.mjs", postToolUsePayload, baseEnv("http://127.0.0.1:1"), ["PostToolUse"], tmpCwd);
    expect(result.json).toEqual({});
    const spoolFile = path.join(tmpCwd, ".agyhq", "audit-spool.jsonl");
    expect(fs.existsSync(spoolFile)).toBe(true);
    const lines = fs
      .readFileSync(spoolFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { request: { event: string; conversationId: string } });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.request.event).toBe("PostToolUse");
    expect(lines[0]?.request.conversationId).toBe("conv-2");
  });

  it("spools and still prints {} when env vars are missing", async () => {
    const result = await runHook("audit.mjs", postToolUsePayload, {}, ["PostToolUse"], tmpCwd);
    expect(result.json).toEqual({});
    expect(fs.existsSync(path.join(tmpCwd, ".agyhq", "audit-spool.jsonl"))).toBe(true);
  });
});

describe("context.mjs", () => {
  const preInvocationPayload = JSON.stringify({
    conversationId: "conv-3",
    invocationNum: 0,
    initialNumSteps: 1,
    transcriptPath: "/tmp/transcript.jsonl",
    workspacePaths: [tmpCwd],
    modelName: "gemini-3.8-flash-low",
  });

  it("maps messages to injectSteps", async () => {
    daemon.setHandler(HOOK_ROUTES.context, () => ({
      envelope: { ok: true, data: { messages: ["Customer prefers Vietnamese."] } },
    }));
    const result = await runHook("context.mjs", preInvocationPayload, baseEnv(daemon.url), [], tmpCwd);
    expect(result.json).toEqual({ injectSteps: [{ ephemeralMessage: "Customer prefers Vietnamese." }] });
  });

  it("caps total injected size at 4000 chars", async () => {
    const long = "x".repeat(5000);
    daemon.setHandler(HOOK_ROUTES.context, () => ({ envelope: { ok: true, data: { messages: [long] } } }));
    const result = await runHook("context.mjs", preInvocationPayload, baseEnv(daemon.url), [], tmpCwd);
    const steps = (result.json as { injectSteps: Array<{ ephemeralMessage: string }> }).injectSteps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.ephemeralMessage.length).toBe(4000);
    expect(steps[0]!.ephemeralMessage.endsWith("...")).toBe(true);
  });

  it("returns {} (no injection) when the daemon is unreachable", async () => {
    const result = await runHook("context.mjs", preInvocationPayload, baseEnv("http://127.0.0.1:1"), [], tmpCwd);
    expect(result.json).toEqual({});
  });

  it("returns {} when env vars are missing", async () => {
    const result = await runHook("context.mjs", preInvocationPayload, {}, [], tmpCwd);
    expect(result.json).toEqual({});
  });
});

describe("stop.mjs", () => {
  const stopPayload = (executionNum: number, conversationId = "conv-4") =>
    JSON.stringify({
      conversationId,
      executionNum,
      terminationReason: "NO_TOOL_CALL",
      error: "",
      fullyIdle: true,
      transcriptPath: "/tmp/transcript.jsonl",
      workspacePaths: [tmpCwd],
      modelName: "gemini-3.8-flash-low",
    });

  it("maps a continue decision through", async () => {
    daemon.setHandler(HOOK_ROUTES.stop, () => ({ envelope: { ok: true, data: { decision: "continue", reason: "not done" } } }));
    const result = await runHook("stop.mjs", stopPayload(0), baseEnv(daemon.url), [], tmpCwd);
    expect(result.json).toEqual({ decision: "continue", reason: "not done" });
  });

  it("maps a stop decision to {}", async () => {
    daemon.setHandler(HOOK_ROUTES.stop, () => ({ envelope: { ok: true, data: { decision: "stop" } } }));
    const result = await runHook("stop.mjs", stopPayload(0), baseEnv(daemon.url), [], tmpCwd);
    expect(result.json).toEqual({});
  });

  it("falls back to a plain stop when the daemon is unreachable", async () => {
    const result = await runHook("stop.mjs", stopPayload(0), baseEnv("http://127.0.0.1:1"), [], tmpCwd);
    expect(result.json).toEqual({});
  });

  it("stops immediately once executionNum reaches the loop-guard limit, without calling the daemon", async () => {
    daemon.setHandler(HOOK_ROUTES.stop, () => ({ envelope: { ok: true, data: { decision: "continue", reason: "keep going" } } }));
    const result = await runHook("stop.mjs", stopPayload(2), baseEnv(daemon.url), [], tmpCwd);
    expect(result.json).toEqual({});
    expect(daemon.requests).toHaveLength(0);
  });

  it("guards via the state file across separate processes for the same conversation", async () => {
    daemon.setHandler(HOOK_ROUTES.stop, () => ({ envelope: { ok: true, data: { decision: "continue", reason: "keep going" } } }));

    // Each invocation is a fresh process with executionNum reset to 0, as
    // happens when the daemon forces continuation across resumed task runs
    // (see src/stop-state.ts). The persisted count must still catch this.
    const first = await runHook("stop.mjs", stopPayload(0, "conv-guard"), baseEnv(daemon.url), [], tmpCwd);
    expect(first.json).toEqual({ decision: "continue", reason: "keep going" });

    const second = await runHook("stop.mjs", stopPayload(0, "conv-guard"), baseEnv(daemon.url), [], tmpCwd);
    expect(second.json).toEqual({ decision: "continue", reason: "keep going" });

    // Third attempt: guard count is now 2 -> force a plain stop, no daemon call.
    const requestsBefore = daemon.requests.length;
    const third = await runHook("stop.mjs", stopPayload(0, "conv-guard"), baseEnv(daemon.url), [], tmpCwd);
    expect(third.json).toEqual({});
    expect(daemon.requests.length).toBe(requestsBefore);
  });
});
