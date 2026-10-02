#!/usr/bin/env node
// Fake `agy` binary for @agyhq/server orchestrator/quota tests. Adapted from
// packages/runner/test/fixtures/fake-agy.mjs (same NDJSON shapes / --version /
// /usage handling) with one addition: the "result" scenario's
// structured_output is controllable via FAKE_AGY_RESULT (a JSON string),
// since the orchestrator always passes --json-schema and needs to see every
// TaskResult shape (done / needs_human / waiting_external / failed /
// followUp) to exercise its outcome-mapping logic. /usage's remaining
// fractions are controllable via FAKE_AGY_QUOTA_FRACTION for quota-throttle
// tests.

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const CONV_ID = "fake-conversation-id-0001";

if (argv.includes("--version")) {
  process.stdout.write("1.2.14-fake\n");
  process.exit(0);
}

if (argv.includes("/usage")) {
  const fraction = process.env.FAKE_AGY_QUOTA_FRACTION ? Number(process.env.FAKE_AGY_QUOTA_FRACTION) : 0.6;
  const payload = {
    conversation_id: "",
    status: "SUCCESS",
    response: "",
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
            description: "d",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit Remaining",
                description: "d",
                window: "weekly",
                remaining_fraction: fraction,
                reset_time: "2026-10-07T02:28:26Z",
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

function initEvent() {
  emit({
    event: "init",
    conversation_id: CONV_ID,
    init: { model: "gemini-3.8-flash-low", cwd: process.cwd(), tools: [], permission_mode: "always-proceed" },
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
  const scenario = process.env.FAKE_AGY_SCENARIO ?? "result";

  switch (scenario) {
    case "result": {
      const structured = JSON.parse(process.env.FAKE_AGY_RESULT ?? '{"status":"done","summary":"ok"}');
      initEvent();
      emit({
        event: "result",
        result: {
          conversation_id: CONV_ID,
          status: "SUCCESS",
          response: JSON.stringify(structured),
          duration_seconds: 0.2,
          num_turns: 1,
          structured_output: structured,
          usage: usage(30),
        },
      });
      process.exit(0);
      break;
    }

    case "print_timeout": {
      initEvent();
      process.stderr.write("[agy] print timeout after 1s with turn in progress; returning partial output\n");
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

    case "exit1": {
      initEvent();
      emit({
        event: "result",
        result: { conversation_id: CONV_ID, status: "ERROR", response: "", error: "boom", duration_seconds: 0.1, num_turns: 1, usage: usage(0) },
      });
      process.exit(1);
      break;
    }

    default: {
      process.stderr.write(`fake-agy: unknown scenario "${scenario}"\n`);
      process.exit(2);
    }
  }
}

main();
