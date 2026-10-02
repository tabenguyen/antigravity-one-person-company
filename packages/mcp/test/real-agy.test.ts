// Opt-in end-to-end test: spawns the REAL `agy` CLI headless, pointed at a
// temp workspace whose .agents/mcp_config.json registers our built
// company-mcp binary under the "company" server key (per the contract in
// docs/PHASE0.md D3 / COMPANY_MCP_SERVER), and a mock daemon standing in for
// agy-hq. Verifies:
//   1. agy actually calls our kb_search tool and the final answer contains a
//      snippet only the mock daemon could have supplied (proves the whole
//      chain: agy -> MCP child process -> HqClient -> HTTP -> back).
//   2. whether the MCP child process received the AGYHQ_* env vars from
//      agy's own environment (we deliberately do NOT set "env" in
//      mcp_config.json) — this is a load-bearing fact for @agyhq/workspace
//      and @agyhq/runner, which is why we assert and log it explicitly
//      rather than just hoping.
//
// Gated by AGYHQ_REAL_AGY=1 because it shells out to a real model and costs
// quota/time. Skipped otherwise (and if the binary or the build isn't
// present).
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { ENV, COMPANY_MCP_SERVER } from "@agyhq/core";
import { startMockDaemon, type MockDaemon } from "./mock-daemon.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(here, "../dist/company-mcp.mjs");
const AGY_BIN = path.join(homedir(), ".local/bin/agy");

const ENABLED = process.env.AGYHQ_REAL_AGY === "1";
const DIST_EXISTS = existsSync(DIST_ENTRY);
const AGY_EXISTS = existsSync(AGY_BIN);

const SNIPPET = "ZORBATRON-7F3A21-SNIPPET";
const AGENT_ID = "sdr-real-agy-test";

const run = ENABLED && DIST_EXISTS && AGY_EXISTS ? describe : describe.skip;

if (ENABLED && (!DIST_EXISTS || !AGY_EXISTS)) {
  // eslint-disable-next-line no-console
  console.warn(
    `[real-agy.test] AGYHQ_REAL_AGY=1 but prerequisites missing (dist built: ${DIST_EXISTS}, agy at ${AGY_BIN}: ${AGY_EXISTS}); skipping.`
  );
}

run("company-mcp with real agy (opt-in, AGYHQ_REAL_AGY=1)", () => {
  let workDir: string;
  let daemon: MockDaemon;
  let envInherited: boolean | null = null;

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "agyhq-mcp-real-"));
    mkdirSync(path.join(workDir, ".agents"), { recursive: true });

    daemon = await startMockDaemon((req) => {
      if (req.url === "/v1/mcp/kb_search") {
        return {
          status: 200,
          body: { ok: true, data: { results: [{ docId: "d1", title: "Test doc", scope: "company", snippet: SNIPPET, score: 1 }] } },
        };
      }
      return { status: 200, body: { ok: true, data: {} } };
    });

    // Deliberately no "env" key here: we want to find out whether agy passes
    // its OWN process env through to the MCP child by default.
    writeFileSync(
      path.join(workDir, ".agents/mcp_config.json"),
      JSON.stringify({ mcpServers: { [COMPANY_MCP_SERVER]: { command: process.execPath, args: [DIST_ENTRY] } } }, null, 2)
    );
  });

  afterAll(async () => {
    await daemon?.close();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.info(
      `[real-agy.test] RESULT: company-mcp ${envInherited ? "DID" : "DID NOT"} receive AGYHQ_* env from agy's own process env (env inheritance = ${envInherited}).`
    );
  });

  it(
    "agy calls kb_search via the company MCP server and the answer contains the mock daemon's snippet",
    async () => {
      const prompt =
        "Use your kb_search tool (server name 'company') to search the knowledge base for the query 'test'. " +
        "Then reply with ONLY the exact 'snippet' field value from the single result you get back, nothing else.";

      const { stdout, stderr, code } = await runAgy({
        cwd: workDir,
        env: {
          ...process.env,
          [ENV.apiUrl]: daemon.baseUrl,
          [ENV.token]: "real-agy-test-token",
          [ENV.agentId]: AGENT_ID,
        },
        args: [
          "--output-format",
          "json",
          "--dangerously-skip-permissions",
          "--model",
          "gemini-3.8-flash-low",
          "--print-timeout",
          "60s",
          "-p",
          prompt,
        ],
      });

      const kbCall = daemon.captured.find((r) => r.url === "/v1/mcp/kb_search");
      envInherited = !!kbCall && kbCall.headers["x-agyhq-agent-id"] === AGENT_ID;

      // eslint-disable-next-line no-console
      console.info("[real-agy.test] exit code:", code);
      // eslint-disable-next-line no-console
      console.info("[real-agy.test] daemon received kb_search call:", !!kbCall);
      // eslint-disable-next-line no-console
      console.info("[real-agy.test] stderr tail:", stderr.slice(-2000));

      expect(kbCall, "mock daemon never received a /v1/mcp/kb_search call from the MCP server").toBeTruthy();
      expect(envInherited, "AGYHQ_AGENT_ID header on the daemon request did not match — env was not inherited by the MCP child").toBe(
        true
      );

      let parsed: { status?: string; response?: string } = {};
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // fall through; assertion below on stdout will fail with useful context
      }

      expect(parsed.response, `expected a JSON response from agy; got stdout: ${stdout.slice(0, 1000)}`).toBeTruthy();
      expect(parsed.response).toContain(SNIPPET);
    },
    120_000
  );
});

function runAgy(opts: { cwd: string; env: NodeJS.ProcessEnv; args: string[] }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(AGY_BIN, opts.args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 110_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ stdout, stderr, code });
    });
  });
}
