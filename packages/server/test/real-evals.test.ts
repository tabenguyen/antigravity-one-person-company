// Opt-in baseline run of a shipped eval suite (default Sales SDR; AGYHQ_EVAL_SUITE=account-manager|chief-of-staff|fanpage-manager)
// against the REAL `agy` CLI
// (AGYHQ_REAL_AGY=1). One model run per case (maxAttempts 1, cases run sequentially).
// This test records results; it deliberately does NOT require every case to pass — the
// point of the suite is to measure the template, and failures are findings.
//
//   AGYHQ_REAL_AGY=1 AGYHQ_EVAL_KEEP=1 npx vitest run packages/server/test/real-evals.test.ts
//
// AGYHQ_EVAL_MODEL overrides the model (default gemini-3.8-flash-medium);
// AGYHQ_EVAL_CASES="id1,id2" runs a subset; AGYHQ_EVAL_OUT=<file> writes the JSON results there.
//
//   AGYHQ_REAL_AGY=1 AGYHQ_EVAL_SUITE=fanpage-manager npx vitest run packages/server/test/real-evals.test.ts

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalCases } from "../src/evals/runner.ts";
import { loadSuite } from "../src/evals/suite.ts";
import { makeTestConfig, REPO_ROOT } from "./helpers.ts";

const AGY_BIN = path.join(homedir(), ".local/bin/agy");
const HOOKS_DIST = path.join(REPO_ROOT, "packages/hooks/dist/pre-tool-use.mjs");
const MCP_DIST = path.join(REPO_ROOT, "packages/mcp/dist/company-mcp.mjs");

const ENABLED = process.env.AGYHQ_REAL_AGY === "1";
const SUITE = process.env.AGYHQ_EVAL_SUITE ?? "sales-sdr";
const PREREQS_OK = ENABLED && existsSync(AGY_BIN) && existsSync(HOOKS_DIST) && existsSync(MCP_DIST);
const run = PREREQS_OK ? describe : describe.skip;

if (ENABLED && !PREREQS_OK) {
  // eslint-disable-next-line no-console
  console.warn("[real-evals] AGYHQ_REAL_AGY=1 but agy or the hooks/mcp builds are missing — run `npm run build`. Skipping.");
}

run(`real eval baseline: ${SUITE} suite (opt-in, AGYHQ_REAL_AGY=1)`, () => {
  it(
    "runs every case once and records pass/fail per assertion",
    async () => {
      const config = makeTestConfig({ agyBin: AGY_BIN, runTimeoutMs: 420_000 });
      const model = process.env.AGYHQ_EVAL_MODEL ?? "gemini-3.8-flash-medium";
      const caseIds = process.env.AGYHQ_EVAL_CASES?.split(",").filter(Boolean);
      const total = loadSuite(config.templatesRoot, SUITE).cases.length;

      const { results } = await runEvalCases({
        config,
        suite: SUITE,
        model,
        caseIds,
        caseTimeoutMs: 450_000,
        onCaseDone: (r) => {
          // eslint-disable-next-line no-console
          console.info(`[real-evals] ${r.status.toUpperCase().padEnd(5)} ${r.caseId} (${Math.round(r.durationMs / 1000)}s)`);
        },
      });

      for (const r of results) {
        // eslint-disable-next-line no-console
        console.info(
          `[real-evals] ${r.caseId}: ${r.status}\n` +
            r.assertions.map((a) => `   ${a.ok ? "ok " : "NO "} ${a.name}${a.detail ? `  -- ${a.detail}` : ""}`).join("\n"),
        );
      }
      const pass = results.filter((r) => r.status === "pass").length;
      // eslint-disable-next-line no-console
      console.info(`[real-evals] model=${model} pass ${pass}/${results.length}`);
      if (process.env.AGYHQ_EVAL_OUT) writeFileSync(process.env.AGYHQ_EVAL_OUT, JSON.stringify({ model, results }, null, 2));

      expect(results).toHaveLength(caseIds?.length ?? total);
    },
    60 * 60_000,
  );
});
