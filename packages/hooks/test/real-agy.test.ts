// Opt-in end-to-end test: spawns the REAL `agy` CLI against a temp workspace
// wired up with our built hook scripts, and a mock daemon that denies
// run_command. Verifies the mock saw the PreToolUse request and the command
// never actually ran.
//
// Gated by AGYHQ_REAL_AGY=1 because it costs real model time/quota (per
// docs/PHASE0.md D7) and needs the `agy` binary installed. Run with:
//   AGYHQ_REAL_AGY=1 npx vitest run packages/hooks/test/real-agy.test.ts

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_ROUTES } from "@agyhq/core";
import { startMockDaemon, type MockDaemon } from "./mock-daemon.ts";
import { distPath } from "./spawn-hook.ts";

const RUN = process.env["AGYHQ_REAL_AGY"] === "1";
const AGY_BIN = process.env["AGY_BIN"] ?? path.join(os.homedir(), ".local", "bin", "agy");
const MODEL = "gemini-3.8-flash-low";

describe.skipIf(!RUN)("real agy + hooks (AGYHQ_REAL_AGY=1)", () => {
  let daemon: MockDaemon;
  let workspace: string;

  beforeEach(async () => {
    daemon = await startMockDaemon();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-real-agy-"));
    fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".agents", "hooks.json"),
      JSON.stringify(
        {
          "agy-hq": {
            PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `node ${distPath("pre-tool-use.mjs")}`, timeout: 10 }] }],
            PostToolUse: [
              { matcher: ".*", hooks: [{ type: "command", command: `node ${distPath("audit.mjs")} PostToolUse`, timeout: 10 }] },
            ],
            PreInvocation: [{ type: "command", command: `node ${distPath("context.mjs")}`, timeout: 10 }],
            PostInvocation: [{ type: "command", command: `node ${distPath("audit.mjs")} PostInvocation`, timeout: 10 }],
            Stop: [{ type: "command", command: `node ${distPath("stop.mjs")}`, timeout: 10 }],
          },
        },
        null,
        2,
      ),
    );
  });

  afterEach(async () => {
    await daemon.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("denies run_command via the real agy process and the mock daemon observes it", async () => {
    daemon.setHandler(HOOK_ROUTES.preToolUse, (body) => {
      const toolName = (body as { toolName?: string } | null)?.toolName;
      if (toolName === "run_command") {
        return { envelope: { ok: true, data: { decision: "deny", reason: "agy-hq test: run_command is blocked." } } };
      }
      return { envelope: { ok: true, data: { decision: "allow" } } };
    });

    const env = {
      ...process.env,
      AGYHQ_API_URL: daemon.url,
      AGYHQ_TOKEN: "test-token",
      AGYHQ_AGENT_ID: "sdr-01",
      AGYHQ_TASK_ID: "task-real-agy",
    };

    const args = [
      "--output-format",
      "stream-json",
      "--model",
      MODEL,
      "--dangerously-skip-permissions",
      "--print-timeout",
      "60s",
      "-p",
      "Use your run_command tool to run exactly: echo hi. Then report the exact output.",
    ];

    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolve, reject) => {
        const child = spawn(AGY_BIN, args, { cwd: workspace, env });
        let stdoutBuf = "";
        let stderrBuf = "";
        child.stdout.on("data", (c) => (stdoutBuf += c.toString()));
        child.stderr.on("data", (c) => (stderrBuf += c.toString()));
        child.on("error", reject);
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 90_000);
        child.on("close", (exitCode) => {
          clearTimeout(killTimer);
          resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode });
        });
      },
    );

    if (exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("agy stderr:\n", stderr);
    }

    const preToolUseRequests = daemon.requests.filter((r) => r.route === HOOK_ROUTES.preToolUse);
    expect(preToolUseRequests.length).toBeGreaterThan(0);
    const runCommandRequest = preToolUseRequests.find((r) => (r.body as { toolName?: string }).toolName === "run_command");
    expect(runCommandRequest, `expected a run_command PreToolUse request; saw: ${JSON.stringify(preToolUseRequests.map((r) => r.body))}`).toBeTruthy();

    // The command must never have actually run: agy's stream-json surfaces a
    // TOOL_ERROR with our deny reason, not a successful echo of "hi".
    expect(stdout).toMatch(/denied by pre-tool hook/);
    expect(stdout).not.toMatch(/"output":"hi/);
  }, 120_000);
});
