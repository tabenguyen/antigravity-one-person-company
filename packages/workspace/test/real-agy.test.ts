// Opt-in integration test: actually spawns the real `agy` CLI against a
// rendered sales-sdr workspace, with hooks pointing at trivial allow/no-op
// stub scripts (test/fixtures/stub-hooks/*.mjs) and MCP pointing at a stub
// server (test/fixtures/stub-mcp/server.mjs), and checks the agent answers
// "who are you" in persona.
//
// Gated by AGYHQ_REAL_AGY=1 because it spends real model credits and needs
// the `agy` binary installed. Per the task brief: run it once and report.
//
//   AGYHQ_REAL_AGY=1 npx vitest run packages/workspace/test/real-agy.test.ts

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTemplate, renderWorkspace } from "../src/index.ts";
import { makeAgent, makeVars } from "./helpers.ts";

const RUN = process.env.AGYHQ_REAL_AGY === "1";
const AGY_BIN = process.env.AGY_BIN ?? path.join(os.homedir(), ".local/bin/agy");

describe.skipIf(!RUN)("real agy end-to-end (opt-in)", () => {
  it("answers 'who are you' in the sales-sdr persona from a rendered workspace", () => {
    const templatesRoot = path.resolve(import.meta.dirname, "../../../templates");
    const template = loadTemplate(templatesRoot, "sales-sdr");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-real-agy-"));
    const fixturesDir = path.join(import.meta.dirname, "fixtures");

    const agent = makeAgent({
      id: "sdr-real-test",
      displayName: "Mai",
      model: "gemini-3.8-flash-low",
      policy: template.policy,
      workspacePath: outDir,
    });
    const vars = makeVars({
      companyName: "Makini",
      nodeBin: process.execPath,
      hooksDistDir: path.join(fixturesDir, "stub-hooks"),
      mcpEntry: path.join(fixturesDir, "stub-mcp/server.mjs"),
    });
    renderWorkspace({ agent, template, templatesRoot, outDir, vars });

    const env = {
      ...process.env,
      AGYHQ_API_URL: "http://127.0.0.1:7317",
      AGYHQ_TOKEN: "test-token",
      AGYHQ_AGENT_ID: agent.id,
      AGYHQ_TASK_ID: "test-task",
    };

    const stdout = execFileSync(
      AGY_BIN,
      [
        "--output-format",
        "json",
        "--agent",
        "sales-sdr",
        "--model",
        agent.model,
        "--dangerously-skip-permissions",
        "--print-timeout",
        "60s",
        "-p",
        "Who are you? Answer in one short sentence, stating your name and role.",
      ],
      { cwd: outDir, env, timeout: 90_000, encoding: "utf8" },
    );

    const result = JSON.parse(stdout) as { status: string; response: string };
    expect(result.status).toBe("SUCCESS");
    expect(result.response.toLowerCase()).toContain("mai");
    expect(result.response.toLowerCase()).toMatch(/sales development representative|sdr/);

    fs.rmSync(outDir, { recursive: true, force: true });
  }, 100_000);
});
