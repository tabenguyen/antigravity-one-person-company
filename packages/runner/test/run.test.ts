import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { startRun, runAgy } from "../src/run.ts";

const FAKE_AGY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures", "fake-agy.mjs");

function scenario(name: string, extraEnv: Record<string, string> = {}): Record<string, string> {
  return { FAKE_AGY_SCENARIO: name, ...extraEnv };
}

describe("runAgy / startRun — argv and stdin contract", () => {
  it("invokes agy with the exact flag shape from docs/PHASE0.md D2, and the stream-json user-turn stdin line", async () => {
    const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-debug-")), "debug.json");
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hello there",
      agent: "sales-sdr",
      model: "gemini-3.8-flash-low",
      conversationId: "conv-xyz",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("ok", { FAKE_AGY_DEBUG_FILE: debugFile }),
    });

    expect(result.outcome).toBe("ok");

    const debug = JSON.parse(fs.readFileSync(debugFile, "utf8")) as { argv: string[]; stdin: string };
    const argv = debug.argv;

    expect(argv).toContain("--print=");
    expect(argv).not.toContain("--print"); // never the bare/greedy form
    expect(argv.join(" ")).toContain("--input-format stream-json");
    expect(argv.join(" ")).toContain("--output-format stream-json");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv.join(" ")).toContain("--agent sales-sdr");
    expect(argv.join(" ")).toContain("--model gemini-3.8-flash-low");
    expect(argv.join(" ")).toContain("--conversation conv-xyz");

    // --print-timeout must carry a Go-duration unit suffix ("10s"), never a
    // bare number — a bare number fails agy's argument parsing.
    const ptIndex = argv.indexOf("--print-timeout");
    expect(ptIndex).toBeGreaterThanOrEqual(0);
    expect(argv[ptIndex + 1]).toMatch(/^\d+s$/);
    expect(argv[ptIndex + 1]).toBe("10s");

    expect(JSON.parse(debug.stdin.trim())).toEqual({
      event: "user",
      message: { role: "user", content: "hello there" },
    });
  });

  it("writes jsonSchema to a temp file, passes --json-schema <file>, and cleans the file up after the run", async () => {
    const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-debug-")), "debug.json");
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };

    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "schema test",
      jsonSchema: schema,
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("ok_structured", { FAKE_AGY_DEBUG_FILE: debugFile }),
    });
    expect(result.outcome).toBe("ok");
    expect(result.structured).toEqual({ status: "ok", summary: "done", count: 1 });

    const debug = JSON.parse(fs.readFileSync(debugFile, "utf8")) as { argv: string[] };
    const schemaIndex = debug.argv.indexOf("--json-schema");
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    const schemaPath = debug.argv[schemaIndex + 1]!;
    expect(schemaPath.endsWith(".json")).toBe(true);
    // The fake process read it fine while running...
    expect(fs.existsSync(schemaPath)).toBe(false); // ...but the Runner cleans it up afterward.
  });
});

describe("runAgy — result classification", () => {
  it("ok: a clean run with text response", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("ok"),
    });
    expect(result.outcome).toBe("ok");
    expect(result.text).toBe("hello from fake agy");
    expect(result.conversationId).toBe("fake-conversation-id-0001");
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 18, outputTokens: 2, totalTokens: 20, thinkingTokens: 0, cacheReadTokens: 0 });
    expect(result.deniedActions).toEqual([]);
    expect(result.agyVersion).toBe("1.2.14-fake");
    expect(result.error).toBeNull();
  });

  it("ok: structured output matches the schema", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      jsonSchema: { type: "object" },
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("ok_structured"),
    });
    expect(result.outcome).toBe("ok");
    expect(result.structured).toEqual({ status: "ok", summary: "done", count: 1 });
  });

  it("timeout: agy's own print-timeout marker on stderr, status SUCCESS, exit 0", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("print_timeout"),
    });
    expect(result.outcome).toBe("timeout");
    expect(result.exitCode).toBe(0);
    expect(result.stderrTail).toContain("print timeout after");
  });

  it("denied: non-empty denied_actions even though status is SUCCESS", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("denied_actions"),
    });
    expect(result.outcome).toBe("denied");
    expect(result.deniedActions).toEqual([{ action: "command", display_name: "RunCommand" }]);
  });

  it("empty: no text and no structured output, no schema requested", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("empty"),
    });
    expect(result.outcome).toBe("empty");
  });

  it("invalid_output: schema requested but structured_output missing", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      jsonSchema: { type: "object" },
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("empty"),
    });
    expect(result.outcome).toBe("invalid_output");
  });

  it("error: no result event at all", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("missing_result"),
    });
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBe(0);
  });

  it("error: non-zero exit code", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("exit1"),
    });
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  it("error: spawn failure (nonexistent binary) resolves a result, never rejects/throws", async () => {
    const result = await runAgy({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: "/nonexistent/binary/agy",
    });
    expect(result.outcome).toBe("error");
    expect(result.error).toBeTruthy();
  });

  it(
    "timeout: a hung process is killed by the Runner's own watchdog (SIGTERM at timeoutMs+15s)",
    async () => {
      const result = await runAgy({
        cwd: process.cwd(),
        prompt: "hi",
        timeoutMs: 50,
        agyBin: FAKE_AGY,
        env: scenario("hang"),
      });
      expect(result.outcome).toBe("timeout");
    },
    25_000,
  );
});

describe("startRun — live handle", () => {
  it("exposes pid and yields AgyEvents through handle.events as they arrive", async () => {
    const handle = startRun({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("ok"),
    });
    expect(typeof handle.pid).toBe("number");

    const events = [];
    for await (const ev of handle.events) {
      events.push(ev);
    }
    expect(events.map((e) => e.event)).toEqual(["init", "step_update", "result"]);

    const result = await handle.result;
    expect(result.outcome).toBe("ok");
  });

  it("kill() terminates the process and the result classifies as error", async () => {
    const handle = startRun({
      cwd: process.cwd(),
      prompt: "hi",
      timeoutMs: 10_000,
      agyBin: FAKE_AGY,
      env: scenario("hang"),
    });
    handle.kill("test-initiated");
    const result = await handle.result;
    expect(result.outcome).toBe("error");
  });
});
