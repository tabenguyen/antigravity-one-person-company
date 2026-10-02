#!/usr/bin/env node
// Fake `agy` for the eval runner tests. Unlike fake-agy.mjs it can also ACT like an agent:
// it replays a scripted list of company-MCP tool calls against the daemon's agent API (with
// the per-run token the orchestrator put in AGYHQ_*), so audit "tool.pre" events, drafts, CRM
// changes and child tasks all appear exactly as they would in a real run.
//
// FAKE_EVAL_SCRIPT = JSON array of { match, actions?, result, hang? }:
//   match   regex source tested (case-insensitive) against the prompt on stdin; first hit wins
//   actions [{ tool, input }]; input.contactEmail is resolved to contactId via crm_find_contact
//   result  structured_output returned as the final task result
//   hang    never finish (timeout test)

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("1.2.14-fake-eval\n");
  process.exit(0);
}
if (argv.includes("/usage")) {
  process.stdout.write(
    JSON.stringify({
      status: "SUCCESS",
      command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ id: "w", name: "Weekly", window: "weekly", remaining_fraction: 0.9, reset_time: "2026-10-07T00:00:00Z" }] }] } },
    }),
  );
  process.exit(0);
}

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  // no stdin
}

const CONV = "fake-eval-conversation";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const api = process.env.AGYHQ_API_URL;
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${process.env.AGYHQ_TOKEN}`,
  "x-agyhq-agent-id": process.env.AGYHQ_AGENT_ID ?? "",
  "x-agyhq-task-id": process.env.AGYHQ_TASK_ID ?? "",
};

async function post(path, body) {
  const res = await fetch(`${api}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return res.json();
}

async function callTool(tool, input) {
  await post("/v1/hooks/pre-tool-use", {
    conversationId: CONV,
    toolName: "call_mcp_tool",
    parameters: { ServerName: "company", ToolName: tool, Arguments: input },
  });
  return post(`/v1/mcp/${tool}`, input);
}

async function main() {
  emit({ event: "init", conversation_id: CONV, init: { model: "fake", cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } });
  const script = JSON.parse(process.env.FAKE_EVAL_SCRIPT ?? "[]");
  const entry = script.find((e) => new RegExp(e.match, "i").test(stdin));
  if (!entry) {
    process.stderr.write("fake-eval-agy: no script entry matched the prompt\n");
    process.exit(3);
  }
  if (entry.hang) {
    setInterval(() => {}, 1000);
    return;
  }
  for (const action of entry.actions ?? []) {
    const input = { ...action.input };
    if (input.contactEmail) {
      const found = await callTool("crm_find_contact", { email: input.contactEmail });
      input.contactId = found.data.contacts[0].id;
      delete input.contactEmail;
    }
    const out = await callTool(action.tool, input);
    if (!out.ok) process.stderr.write(`fake-eval-agy: ${action.tool} failed: ${JSON.stringify(out.error)}\n`);
  }
  emit({
    event: "result",
    result: {
      conversation_id: CONV,
      status: "SUCCESS",
      response: JSON.stringify(entry.result),
      duration_seconds: 0.1,
      num_turns: 1,
      structured_output: entry.result,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  });
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
