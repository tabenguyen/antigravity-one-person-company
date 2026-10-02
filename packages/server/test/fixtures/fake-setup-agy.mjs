#!/usr/bin/env node
// Fake `agy` for the setup-wizard generator tests. Each invocation consumes the next entry of the "turns" array in the
// JSON file named by FAKE_SETUP_SCRIPT (invocation number kept in FAKE_SETUP_SCRIPT + ".count"); every invocation's
// argv/stdin/cwd is appended to FAKE_SETUP_LOG as one JSON line.
//   turn = { kind: "ok", structured: {...} }   tool steps + finish + result with structured_output
//        | { kind: "no_structured", text? }    result without structured_output (text = the final answer text)
//        | { kind: "hang" }                    emits init, then never finishes (cancel / timeout tests)
//        | { kind: "error", message }          result status ERROR, exit 1
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("1.2.14-fake\n");
  process.exit(0);
}

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {}

const scriptPath = process.env.FAKE_SETUP_SCRIPT;
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
const countPath = `${scriptPath}.count`;
const n = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(n + 1));
const turn = script.turns[Math.min(n, script.turns.length - 1)];

const convIdx = argv.indexOf("--conversation");
const CONV = convIdx >= 0 ? argv[convIdx + 1] : "fake-setup-conv-0001";
if (process.env.FAKE_SETUP_LOG) {
  appendFileSync(process.env.FAKE_SETUP_LOG, JSON.stringify({ n, argv, stdin, cwd: process.cwd() }) + "\n");
}

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: i + o });
emit({ event: "init", conversation_id: CONV, init: { model: "fake", cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } });

if (turn.kind === "hang") {
  setInterval(() => {}, 1000);
} else {
  const step = (i, state, type, extra = {}) =>
    emit({ event: "step_update", step_update: { conversation_id: CONV, step_index: i, state, step_type: type, ...extra } });
  const tool = (i, name, parameters, state = "DONE", error) =>
    step(i, state, "tool", { tool_name: name, tool_info: { name, parameters, ...(error ? { error } : {}) } });
  tool(1, "read_url_content", { Url: "https://acme.example/" }, "ACTIVE");
  tool(1, "read_url_content", { Url: "https://acme.example/" });
  tool(2, "view_file", { AbsolutePath: "/x/content.md" });
  tool(3, "run_command", { CommandLine: "ls" }, "ERROR", { type: "denied", message: "tool call denied by pre-tool hook" });
  step(4, "ACTIVE", "agent_response", { text_delta: "Reading pricing now" });
  step(4, "DONE", "agent_response");
  if (turn.kind === "error") {
    emit({ event: "result", result: { conversation_id: CONV, status: "ERROR", response: "", error: turn.message ?? "boom", duration_seconds: 0.1, num_turns: 1, usage: usage(0, 0) } });
    process.exit(1);
  }
  step(5, "DONE", "finish");
  emit({
    event: "result",
    result: {
      conversation_id: CONV,
      status: "SUCCESS",
      response: turn.kind === "ok" ? JSON.stringify(turn.structured) : (turn.text ?? "no structured output"),
      ...(turn.kind === "ok" ? { structured_output: turn.structured } : {}),
      duration_seconds: 0.2,
      num_turns: 1,
      usage: usage(100, 50),
    },
  });
  process.exit(0);
}
