import { describe, expect, it } from "vitest";
import { summarizeRunEvents } from "../src/lib/runEvents.ts";

const step = (step_update: Record<string, unknown>) => ({ type: "run.event", taskId: "t1", event: { event: "step_update", step_update } });

describe("summarizeRunEvents", () => {
  it("joins text deltas per step, labels MCP tools, and drops the user prompt", () => {
    const lines = summarizeRunEvents([
      step({ step_index: 0, step_type: "user_input", state: "DONE" }),
      step({ step_index: 1, step_type: "agent_response", state: "ACTIVE", text_delta: "Looking up " }),
      step({ step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "the lead." }),
      step({ step_index: 2, step_type: "tool", state: "DONE", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: { ServerName: "company", ToolName: "kb_search" } } }),
      step({ step_index: 3, step_type: "tool", state: "ERROR", tool_name: "run_command", tool_info: { name: "run_command", parameters: {} } }),
      { type: "run.event", event: { event: "result", status: "SUCCESS" } },
    ]);
    expect(lines.map((l) => [l.kind, l.label, l.state])).toEqual([
      ["agent_response", "Looking up the lead.", "DONE"],
      ["tool", "company/kb_search", "DONE"],
      ["tool", "run_command", "ERROR"],
      ["result", "run finished (SUCCESS)", "DONE"],
    ]);
  });

  it("ignores malformed events", () => {
    expect(summarizeRunEvents([null, 1, { event: "nope" }, { type: "x" }])).toEqual([]);
  });
});
