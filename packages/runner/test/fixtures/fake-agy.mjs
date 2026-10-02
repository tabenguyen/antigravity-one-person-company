#!/usr/bin/env node
// Fake `agy` binary for @agyhq/runner tests. Emulates the subset of agy
// 1.2.14's stream-json / version / usage behavior the Runner depends on.
// Scenario selected via the FAKE_AGY_SCENARIO env var. Shapes mirror the raw
// transcripts in spike/01-headless-io/raw/ and
// spike/04-concurrency-sdk/runs/probe-usage-0-*/stdout.json.

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const CONV_ID = "fake-conversation-id-0001";

// --version and the /usage probe are handled before anything scenario- or
// stdin-related, mirroring how a real CLI would answer them regardless of
// what a task-run scenario env var happens to be set to.
if (argv.includes("--version")) {
  process.stdout.write("1.2.14-fake\n");
  process.exit(0);
}

if (argv.includes("/usage")) {
  const payload = {
    conversation_id: "",
    status: "SUCCESS",
    response: "Gemini Models\tWeekly Limit Remaining\t61%\t2026-10-07T02:28:26Z\n",
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: {
      name: "usage",
      data: {
        description: "quota groups",
        groups: [
          {
            name: "Gemini Models",
            description: "Gemini Flash, Gemini Pro",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit Remaining",
                description: "d",
                window: "weekly",
                remaining_fraction: 0.6149988770484924,
                reset_time: "2026-10-07T02:28:26Z",
              },
              {
                id: "gemini-5h",
                name: "Five Hour Limit Remaining",
                description: "d",
                window: "5h",
                remaining_fraction: 0.6171101927757263,
                reset_time: "2026-10-01T04:24:32Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            description: "Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [
              {
                id: "3p-weekly",
                name: "Weekly Limit Remaining",
                description: "d",
                window: "weekly",
                remaining_fraction: 0.6344342827796936,
                reset_time: "2026-10-06T18:37:34Z",
              },
            ],
          },
        ],
      },
    },
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const stdin = readStdin();

async function maybeWriteDebugFile() {
  const debugFile = process.env.FAKE_AGY_DEBUG_FILE;
  if (!debugFile) return;
  try {
    await writeFile(debugFile, JSON.stringify({ argv, stdin, cwd: process.cwd() }, null, 2));
  } catch {
    // best-effort
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function initEvent(extra = {}) {
  emit({
    event: "init",
    conversation_id: CONV_ID,
    init: {
      model: "gemini-3.8-flash-low",
      cwd: process.cwd(),
      tools: [],
      permission_mode: "always-proceed",
      ...extra,
    },
  });
}

function usage(total) {
  return {
    input_tokens: Math.max(0, total - 2),
    output_tokens: total > 0 ? 2 : 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: total,
  };
}

async function main() {
  await maybeWriteDebugFile();
  const scenario = process.env.FAKE_AGY_SCENARIO ?? "ok";

  switch (scenario) {
    case "ok": {
      initEvent();
      emit({
        event: "step_update",
        step_update: { conversation_id: CONV_ID, step_index: 0, state: "DONE", step_type: "user_input" },
      });
      emit({
        event: "result",
        result: {
          conversation_id: CONV_ID,
          status: "SUCCESS",
          response: "hello from fake agy",
          duration_seconds: 0.1,
          num_turns: 1,
          usage: usage(20),
        },
      });
      process.exit(0);
      break;
    }

    case "ok_structured": {
      initEvent();
      emit({
        event: "result",
        result: {
          conversation_id: CONV_ID,
          status: "SUCCESS",
          response: '{"status":"ok","summary":"done","count":1,"toolAction":"Finishing task"}',
          duration_seconds: 0.2,
          num_turns: 1,
          structured_output: { status: "ok", summary: "done", count: 1 },
          json_schema: { type: "object" },
          usage: usage(30),
        },
      });
      process.exit(0);
      break;
    }

    case "print_timeout": {
      initEvent();
      process.stderr.write("[agy] print timeout after 3s with turn in progress; returning partial output\n");
      emit({
        event: "step_update",
        step_update: { conversation_id: CONV_ID, step_index: 0, state: "DONE", step_type: "user_input" },
      });
      emit({
        event: "result",
        result: { conversation_id: CONV_ID, status: "SUCCESS", response: "", duration_seconds: 0, num_turns: 1, usage: usage(0) },
      });
      process.exit(0);
      break;
    }

    case "denied_actions": {
      initEvent();
      emit({
        event: "result",
        result: {
          conversation_id: CONV_ID,
          status: "SUCCESS",
          response: "",
          duration_seconds: 1,
          num_turns: 1,
          usage: usage(5),
          denied_actions: [{ action: "command", display_name: "RunCommand" }],
        },
      });
      process.exit(0);
      break;
    }

    case "empty": {
      initEvent();
      emit({
        event: "result",
        result: { conversation_id: CONV_ID, status: "SUCCESS", response: "", duration_seconds: 0.5, num_turns: 1, usage: usage(5) },
      });
      process.exit(0);
      break;
    }

    case "missing_result": {
      initEvent();
      emit({
        event: "step_update",
        step_update: { conversation_id: CONV_ID, step_index: 0, state: "DONE", step_type: "user_input" },
      });
      // Deliberately no "result" event.
      process.exit(0);
      break;
    }

    case "exit1": {
      initEvent();
      emit({
        event: "result",
        result: { conversation_id: CONV_ID, status: "ERROR", response: "", error: "boom", duration_seconds: 0.1, num_turns: 1, usage: usage(0) },
      });
      process.exit(1);
      break;
    }

    case "hang": {
      initEvent();
      // Never emits a result event and never exits on its own — the
      // Runner's own watchdog (SIGTERM, then SIGKILL) must terminate this.
      setInterval(() => {}, 1000);
      break;
    }

    default: {
      process.stderr.write(`fake-agy: unknown scenario "${scenario}"\n`);
      process.exit(2);
    }
  }
}

main();
