// Opt-in integration test against the real agy binary. Skipped by default —
// run with AGYHQ_REAL_AGY=1 (and a real agy install + login on PATH, or
// AGY_BIN pointing at one). Uses the cheapest model to keep quota cost near
// zero (FINDINGS.md: a trivial prompt is ~7s wall, negligible tokens).
import { describe, it, expect } from "vitest";
import { runAgy } from "../src/run.ts";

const enabled = process.env.AGYHQ_REAL_AGY === "1";

describe.skipIf(!enabled)("real agy (opt-in, AGYHQ_REAL_AGY=1)", () => {
  it(
    "runs a trivial prompt against gemini-3.8-flash-low and returns ok with a conversationId",
    async () => {
      const result = await runAgy({
        cwd: process.cwd(),
        prompt: "Reply with exactly the single word: PONG",
        model: "gemini-3.8-flash-low",
        timeoutMs: 60_000,
      });
      expect(result.outcome).toBe("ok");
      expect(result.conversationId).toBeTruthy();
      expect(result.agyVersion).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(0);
    },
    90_000,
  );
});
